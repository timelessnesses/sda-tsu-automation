import { Cookie, parseSetCookie } from 'set-cookie-parser';
import pLimit from 'p-limit';

const limit = pLimit(3);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		console.time('req');
		console.time('cache-session');
		let JSESSION = {
			JSESSIONID: (await env.FUCK_YOU_SDA_KV.get('JSESSIONID')) as string,
		};
		console.timeEnd('cache-session');
		console.time('verify-token');
		if (!(await verifyJsession(JSESSION.JSESSIONID, env.Proxying))) {
			console.timeEnd('verify-token');
			console.time('fetch-login');
			JSESSION = await loginFetch(env.SDA_USERNAME, env.SDA_PASSWORD, env.Proxying);
			console.timeEnd('fetch-login');
			await env.FUCK_YOU_SDA_KV.put('JSESSIONID', JSESSION.JSESSIONID);
		}
		console.time('scan');
		await scan(JSESSION.JSESSIONID, env.Proxying, env.FUCK_YOU_SDA_KV, env.DISCORD_WEBHOOK);
		console.timeEnd('scan');

		// const activities = await getActivityList(JSESSION.JSESSIONID, env.Proxying);
		// const mapped = activities.flat();
		// const newActivitiesKV = mapped.reduce(
		// 	(acc, activity) => {
		// 		acc[activity.activity_id] = activity;
		// 		return acc;
		// 	},
		// 	{} as Record<number, Activity>,
		// );
		// await deleteActivities(JSESSION.JSESSIONID, mapped, env.Proxying);
		console.time('apply');
		await applyAllActivities(JSESSION.JSESSIONID, env.Proxying, env.FUCK_YOU_SDA_KV, env.DISCORD_WEBHOOK);
		console.timeEnd('apply');
		console.timeEnd('req');
		return new Response('Hello world');
	},

	async scheduled(event, env, _): Promise<void> {
		let JSESSION = {
			JSESSIONID: (await env.FUCK_YOU_SDA_KV.get('JSESSIONID')) as string,
		};
		if (!(await verifyJsession(JSESSION.JSESSIONID, env.Proxying))) {
			JSESSION = await loginFetch(env.SDA_USERNAME, env.SDA_PASSWORD, env.Proxying);
			await env.FUCK_YOU_SDA_KV.put('JSESSIONID', JSESSION.JSESSIONID);
		}
		const runAt = new Date(event.scheduledTime);
		console.log('Cron:', event.cron, 'scheduled for', runAt.toISOString());
		// The cron fires every 5 minutes; the run at the top of the hour also refreshes the activity list into KV.
		if (runAt.getMinutes() === 0) {
			console.log('Hourly run: scanning activities');
			await scan(JSESSION.JSESSIONID, env.Proxying, env.FUCK_YOU_SDA_KV, env.DISCORD_WEBHOOK);
		}
		// Every 5 minutes: only apply to activities whose registration window includes right now,
		// or spins until the window opens when it is about to open before the next cron run.
		await applyAllActivities(JSESSION.JSESSIONID, env.Proxying, env.FUCK_YOU_SDA_KV, env.DISCORD_WEBHOOK);
	},
} satisfies ExportedHandler<Env>;

async function deleteActivity(activityId: number, JSESSIONID: string, proxy: Fetcher) {
	const response = await proxy.fetch(DELETE_ACTIVITY_PAGE, {
		method: 'GET',
		headers: {
			Cookie: `JSESSIONID=${JSESSIONID}`,
		},
	});
	console.log(await response.text());
}

async function deleteActivities(JSESSIONID: string, activities: ActivitiesResponse, proxy: Fetcher) {
	await Promise.all(activities.map((activity) => deleteActivity(activity.id, JSESSIONID, proxy)));
}

const REDIRECTED_TO_HOME_PAGE = 'https://sda.tsu.ac.th/student/index.jsp';

async function verifyJsession(JSESSION: string, proxy: Fetcher) {
	const response = await proxy.fetch(ACTIVITY_LIST_PAGE, {
		method: 'GET',
		headers: {
			Cookie: `JSESSIONID=${JSESSION}`,
		},
	});
	// console.log(await response.text());
	// console.log('Verify JSESSION response status:', response.status, response.headers.get("location"));
	return response.status === 302 && response.headers.get('location') === REDIRECTED_TO_HOME_PAGE;
}

const FORM_ACTION = 'เข้าสู่ระบบ';

function buildLoginForm(studentId: string, password: string) {
	const form = new URLSearchParams();
	form.append('action', FORM_ACTION);
	form.append('username', studentId);
	form.append('password', password);
	// console.log(form)
	return form;
}

async function loginFetch(
	studentId: string,
	password: string,
	proxy: Fetcher,
): Promise<{
	JSESSIONID: string;
}> {
	const getResponse = await proxy.fetch(LOGIN_PAGE);
	const initialJSESSIONID = parseSetCookie(getResponse.headers.get('set-cookie') as string, { map: true }).JSESSIONID.value;
	const form = buildLoginForm(studentId, password);
	console.log('Logging in with studentId:', studentId);
	const response = await proxy.fetch(LOGIN_PAGE, {
		method: 'POST',
		body: form,
		headers: {
			// 'Content-Type': 'application/x-www-form-urlencoded',
			Cookie: `JSESSIONID=${initialJSESSIONID}`,
		},
	});
	// console.log('Login response status:', response.status);
	// console.log('Login response location:', response.headers.get("location"));

	return {
		JSESSIONID: initialJSESSIONID,
	};
}

const LOGIN_PAGE = 'https://sda.tsu.ac.th/public/login.jsp';
const ACTIVITY_LIST_PAGE = 'https://sda.tsu.ac.th/student/apply.jsp';
const APPLY_ACTIVITY_PAGE = 'https://sda.tsu.ac.th/student/services/applyActivity.jsp';
const MAIN_HOST = 'https://sda.tsu.ac.th';
const ACTIVITY_DETAIL = 'https://sda.tsu.ac.th/student/services/activity.jsp';

async function applyAllActivities(
	JSESSIONID: string,
	proxy: Fetcher,
	kv: KVNamespace,
	discordWebhook: string,
	now = new Date(),
) {
	let activities = JSON.parse((await kv.get('unappliedActivities')) ?? '{}') as ActivityKV['unappliedActivities'];
	console.log(activities);
	const successfulActivities = JSON.parse((await kv.get('appliedActivities')) ?? '{}') as ActivityKV['appliedActivities'];
	console.log(successfulActivities);
	activities = Object.fromEntries(Object.entries(activities).filter(([id]) => !successfulActivities[id]));
	// Only apply to activities whose registration window (start_date - end_date) includes right now.
	const allActivityIds = Object.keys(activities);
	let activityIds = allActivityIds.filter((id) => isWithinRegistrationRange(activities[id], now));
	if (activityIds.length < allActivityIds.length) {
		console.log(`Skipping ${allActivityIds.length - activityIds.length} activities outside their registration window.`);
	}
	// When a registration window opens within the next few minutes, spin until it opens
	// so we can apply right away instead of waiting for the next cron run.
	const imminent = findImminentActivities(activities, now);
	if (imminent.length > 0) {
		// Add a small random delay so applies don't land machine-exact on the opening second.
		const spinMs = Math.max(imminent[imminent.length - 1].openAtMs - Date.now(), 0) + Math.floor(Math.random() * 2000);
		console.log(
			`${imminent.length} activities open for registration within ${REGISTRATION_SPIN_THRESHOLD_MS / 60000} minutes:`,
			imminent.map(({ id, openAtMs }) => `${id} opens at ${new Date(openAtMs).toISOString()}`),
		);
		console.log(`Spinning for ~${Math.round(spinMs / 1000)}s until registration opens...`);
		await sleep(spinMs);
		now = new Date();
		activityIds = allActivityIds.filter((id) => isWithinRegistrationRange(activities[id], now));
		console.log('Done spinning, activities now in range:', activityIds);
	}
	if (activityIds.length === 0) {
		console.log('No activities are within their registration window right now.');
		return;
	}
	const responses = await applySelectedActivities(JSESSIONID, activityIds, proxy);
	const embeds = [];
	let failed = 0;
	let full = 0;
	console.log(responses);
	for (const response of responses) {
		if (response.result !== 'false') {
			await kv.put('appliedActivities', JSON.stringify({ ...activities, [response.id]: response.result_text }));
			embeds.push(sendSuccessfulApplyDiscordWebhook(discordWebhook, activities[response.id]));
		} else {
			if (response.result_text.includes('กลุ่มนี้เต็มแล้ว')) {
				await kv.put('activityUnableToApply', JSON.stringify({ ...activities, [response.id]: response.result_text }));
				embeds.push(sendUnableToApplyDiscordWebhook(discordWebhook, activities[response.id], response.result_text));
				failed++;
				full++;
			} else {
				failed++;
				await kv.put('unappliedActivities', JSON.stringify({ ...activities, [response.id]: response.result_text }));
				embeds.push(sendFailedApplyDiscordWebhook(discordWebhook, activities[response.id], response.result_text));
			}
		}
	}
	for (const chunk of chunks(embeds, 5)) {
		console.log(JSON.stringify(chunk, null, 2));
		const res = await fetch(discordWebhook, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				...annouceNewApplyEmbedBody,
				embeds: chunk ?? undefined,
				content:
					'Successfully applied to ' +
					(activityIds.length - failed) +
					' activities, failed to apply to ' +
					failed +
					' activities, ' +
					full +
					' activities are full.',
			}),
		});
		if (!res.ok) throw new Error(await res.text());
	}

	const res = await fetch(discordWebhook, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				...annouceNewApplyEmbedBody,
				content:
					'Successfully applied to ' +
					(activityIds.length - failed) +
					' activities, failed to apply to ' +
					failed +
					' activities, ' +
					full +
					' activities are full.',
			}),
		});
		if (!res.ok) throw new Error(await res.text());

	console.log({
		...annouceNewApplyEmbedBody,
		embeds: embeds ?? undefined,
		content:
			'Successfully applied to ' +
			(activityIds.length - failed) +
			' activities, failed to apply to ' +
			failed +
			' activities, ' +
			full +
			' activities are full.',
	});
}

function sendSuccessfulApplyDiscordWebhook(discordWebhook: string, activity: Activity) {
	return customContentActivityEmbed('✅ Successfully applied to activity!', activity);
}

function sendUnableToApplyDiscordWebhook(discordWebhook: string, activity: Activity, response_text: string) {
	return customContentActivityEmbed('❌ Unable to apply to activity!\n' + response_text, activity);
}

function sendFailedApplyDiscordWebhook(discordWebhook: string, activity: Activity, response_text: string) {
	return customContentActivityEmbed('❌ Failed to apply to activity!\n' + response_text, activity);
}

async function getActivityList(JSESSIONID: string, proxy: Fetcher) {
	const response = await proxy.fetch(ACTIVITY_LIST_PAGE, {
		method: 'GET',
		headers: {
			Cookie: `JSESSIONID=${JSESSIONID}`,
		},
	});
	const activitiesId = getActivityListByHtml(await response.text());
	// Stay polite: fetch activity details at most 3 at a time instead of bursting all at once.
	return await Promise.all(
		activitiesId.map((activityId) => limit(async () => {
			const activityDetailUrl = new URL(ACTIVITY_DETAIL);
			activityDetailUrl.searchParams.append('aesID', activityId.id.toString());
			const activityDetailResponse = await proxy.fetch(activityDetailUrl, {
				method: 'GET',
				headers: {
					Cookie: `JSESSIONID=${JSESSIONID}`,
				},
			});
			const detail = (await activityDetailResponse.json()) as ActivitiesResponse;
			return detail;
		})),
	);
}

function getActivityListByHtml(html: string) {
	// console.log('Parsing activity list from HTML', html);
	const activityList: { id: number }[] = [];
	const regex = /data-bs-aesID\s*=\s*["'](\d+)["']/g;
	let match;
	while ((match = regex.exec(html)) !== null) {
		activityList.push({ id: parseInt(match[1]) });
	}
	return activityList;
}

async function applySelectedActivities(JSESSIONID: string, activityIds: string[], proxy: Fetcher) {
	return await Promise.all(
		activityIds.map((activityId) => {
			return limit(() => applyActivity(JSESSIONID, activityId, proxy));
		}),
	);
}

type ActivityKV = {
	appliedActivities: Record<string, Activity>;
	unappliedActivities: Record<string, Activity>;
	activityUnableToApply: Record<string, Activity>;
};

// SDA dates look like "16 ก.ค.  2569 08:00" (Thai month, Buddhist Era year, Asia/Bangkok time).
const THAI_MONTHS: Record<string, number> = {
	'ม.ค.': 0,
	'มค': 0,
	'มกราคม': 0,
	'ก.พ.': 1,
	'กพ': 1,
	'กุมภาพันธ์': 1,
	'มี.ค.': 2,
	'มีค': 2,
	'มีนาคม': 2,
	'เม.ย.': 3,
	'เมย': 3,
	'เมษายน': 3,
	'พ.ค.': 4,
	'พค': 4,
	'พฤษภาคม': 4,
	'มิ.ย.': 5,
	'มิย': 5,
	'มิถุนายน': 5,
	'ก.ค.': 6,
	'กค': 6,
	'กรกฎาคม': 6,
	'ส.ค.': 7,
	'สค': 7,
	'สิงหาคม': 7,
	'ก.ย.': 8,
	'กย': 8,
	'กันยายน': 8,
	'ต.ค.': 9,
	'ตค': 9,
	'ตุลาคม': 9,
	'พ.ย.': 10,
	'พย': 10,
	'พฤศจิกายน': 10,
	'ธ.ค.': 11,
	'ธค': 11,
	'ธันวาคม': 11,
};

// Thailand is UTC+7 all year round (no DST).
const THAILAND_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const BUDDHIST_ERA_OFFSET = 543;

/**
 * Parses an SDA date like "16 ก.ค.  2569 08:00" (Thai month name, Buddhist Era year, Asia/Bangkok time).
 * Returns null when the format is not recognized.
 */
export function parseSdaDate(dateStr: string): Date | null {
	const match = dateStr?.trim().match(/^(\d{1,2})\s+(\S+)\s+(\d{4})\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/);
	if (!match) return null;
	const [, day, monthName, yearStr, hour, minute, second] = match;
	const month = THAI_MONTHS[monthName];
	if (month === undefined) return null;
	let year = parseInt(yearStr, 10);
	if (year >= 2400) year -= BUDDHIST_ERA_OFFSET;
	const utcMs =
		Date.UTC(year, month, parseInt(day, 10), parseInt(hour, 10), parseInt(minute, 10), second ? parseInt(second, 10) : 0) -
		THAILAND_UTC_OFFSET_MS;
	if (Number.isNaN(utcMs)) return null;
	return new Date(utcMs);
}

/**
 * Whether `now` falls within the activity's registration window (start_date - end_date, inclusive).
 * Fails open (returns true) when the dates cannot be parsed, so an unexpected date format
 * never silently skips registrations.
 */
export function isWithinRegistrationRange(activity: Activity, now: Date = new Date()): boolean {
	if (!activity || typeof activity.start_date !== 'string' || typeof activity.end_date !== 'string') return true;
	const start = parseSdaDate(activity.start_date);
	const end = parseSdaDate(activity.end_date);
	if (!start || !end) {
		// Fail open: never silently skip a registration because of an unexpected date format.
		console.warn('Could not parse registration dates for activity', activity.id, ':', activity.start_date, '-', activity.end_date);
		return true;
	}
	return start.getTime() <= now.getTime() && now.getTime() <= end.getTime();
}

/** How far ahead of a registration opening the worker is willing to spin for it. */
// Note: not exported - workerd rejects non-function/handler top-level exports in the entry module.
const REGISTRATION_SPIN_THRESHOLD_MS = 5 * 60 * 1000;
/** Small delay applied after the opening time to absorb clock skew between us and the SDA server. */
const REGISTRATION_OPEN_BUFFER_MS = 1000;

export type ImminentRegistration = {
	id: string;
	/** When to start applying (opening time + skew buffer), in ms since epoch. */
	openAtMs: number;
};

/**
 * Finds activities whose registration opens after `now` but within `thresholdMs`,
 * sorted by opening time (earliest first). Activities that are already open or have
 * unparseable dates are skipped (already-open ones are handled by the in-range check).
 */
export function findImminentActivities(
	activities: Record<string, Activity>,
	now: Date,
	thresholdMs = REGISTRATION_SPIN_THRESHOLD_MS,
): ImminentRegistration[] {
	const imminent: ImminentRegistration[] = [];
	for (const [id, activity] of Object.entries(activities)) {
		if (!activity || typeof activity.start_date !== 'string') continue;
		const start = parseSdaDate(activity.start_date);
		if (!start) continue;
		const waitMs = start.getTime() - now.getTime();
		if (waitMs > 0 && waitMs <= thresholdMs) imminent.push({ id, openAtMs: start.getTime() + REGISTRATION_OPEN_BUFFER_MS });
	}
	return imminent.sort((a, b) => a.openAtMs - b.openAtMs);
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyActivity(JSESSIONID: string, activityId: string, proxy: Fetcher, discordWebhook?: string) {
	const applied = new URL(APPLY_ACTIVITY_PAGE);
	applied.searchParams.append('actesID', activityId);
	applied.searchParams.append('publishyear', '2567');
	const response = (await (
		await proxy.fetch(applied, {
			method: 'GET',
			headers: {
				Cookie: `JSESSIONID=${JSESSIONID}`,
			},
		})
	).json()) as ApplyResponse;
	return response;
}

const DELETE_ACTIVITY_PAGE = 'https://sda.tsu.ac.th/student/services/delActiviity.jsp';

async function scan(JSESSIONID: string, proxy: Fetcher, kv: KVNamespace, discordWebhook: string) {
	const newActivities = await getActivityList(JSESSIONID, proxy);
	console.log('New Activities', newActivities);

	const mapped = newActivities.flat();
	const newActivitiesKV = mapped.reduce(
		(acc, activity) => {
			acc[activity.id] = activity;
			return acc;
		},
		{} as Record<number, Activity>,
	);
	await kv.put('unappliedActivities', JSON.stringify(newActivitiesKV));
	await sendScanDiscordWebhook(discordWebhook, mapped);
}

async function sendScanDiscordWebhook(discordWebhook: string, newActivities: ActivitiesResponse) {
	const embeds = newActivities.map(buildActivityEmbed);

	console.log({
		...annouceNewApplyEmbedBody,
		embeds: embeds,
	});
	for (const chunk of chunks(embeds, 5)) {
		// console.dir(chunk, { depth: 99999 });
		console.log(JSON.stringify(chunk, null, 2));

		const res = await fetch(discordWebhook, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				...annouceNewApplyEmbedBody,
				embeds: chunk ?? undefined,
			}),
		});
		if (!res.ok) throw new Error(await res.text());
	}
}

function customContentActivityEmbed(content: string, activity: Activity) {
	return {
		...buildActivityEmbed(activity),
		title: content + activity.activity,
	};
}

function chunks<T>(array: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size));
	}
	return result;
}

function buildActivityEmbed(activity: Activity) {
	const strippedHtmlDescription = activity.description.replace(/<[^>]*>/g, '\n');
	return {
		description: strippedHtmlDescription.substring(0, 4080) + '...',
		title: activity.activity.substring(0, 100) + '...',
		author: {
			name: `From: ${activity.organization} - ${activity.unit_name} - ${activity.sub_unit_name}`,
			url: MAIN_HOST,
		},
		fields: [
			{
				name: 'Registration Open - Close Date',
				value: `${activity.start_date} - ${activity.end_date}`,
				inline: true,
			},
			{
				name: 'Activity Date',
				value: `${activity.act_date}`,
				inline: true,
			},
			{
				name: 'Venue',
				value: activity.act_place,
				inline: true,
			},
			{
				name: 'Activity Type',
				value: activity.activity_type_name.trim() || 'N/A',
				inline: true,
			},
			{
				name: 'Group Number',
				value: activity.group_number,
				inline: true,
			},
			{
				name: 'Total',
				value: activity.total.toString(),
				inline: true,
			},
			{
				name: 'Number of Applied',
				value: activity.num_apply.toString(),
				inline: true,
			},
		],
		url: MAIN_HOST,
		image: {
			url: encodeURI('https://sda.tsu.ac.th/' + activity.banner_path),
		},
		timestamp: new Date().toISOString(),
	};
}

const annouceNewApplyEmbedBody = {
	content: 'New activity has appeared!',
	// embeds: [],
	flags: 0,
	username: 'SDA Thaksin University Auto Apply',
};

export interface Activity {
	activity_id: number;
	id: number;

	activity: string;
	description: string;

	organization: string;
	unit_name: string;
	sub_unit_name: string;
	activity_type_name: string;

	act_place: string;
	act_date: string;

	start_date: string;
	end_date: string;

	can_apply: 'true' | 'false';

	group_number: string;

	total: number;
	num_apply: number;

	upload_file: string;
	banner_path: string;
}

export type ActivitiesResponse = Activity[];

export type ApplyResponse = {
	id: number;
	result_text: string;
	result: 'true' | 'false';
};
