import { Cookie, parseSetCookie } from 'set-cookie-parser';
import pLimit from 'p-limit';

const limit = pLimit(3);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		let JSESSION = {
			JSESSIONID: (await env.FUCK_YOU_SDA_KV.get('JSESSIONID')) as string,
		};
		if (!(await verifyJsession(JSESSION.JSESSIONID, env.Proxying))) {
			JSESSION = await loginFetch(env.SDA_USERNAME, env.SDA_PASSWORD, env.Proxying);
			await env.FUCK_YOU_SDA_KV.put('JSESSIONID', JSESSION.JSESSIONID);
		}
		await scan(JSESSION.JSESSIONID, env.Proxying, env.FUCK_YOU_SDA_KV, env.DISCORD_WEBHOOK);

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

		await applyAllActivities(JSESSION.JSESSIONID, env.Proxying, env.FUCK_YOU_SDA_KV, env.DISCORD_WEBHOOK);
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
		switch (event.cron) {
			case '0 8 * * *':
				await applyAllActivities(JSESSION.JSESSIONID, env.Proxying, env.FUCK_YOU_SDA_KV, env.DISCORD_WEBHOOK);
				break;
			case '0 */1 * * *':
				await scan(JSESSION.JSESSIONID, env.Proxying, env.FUCK_YOU_SDA_KV, env.DISCORD_WEBHOOK);
				break;
		}
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
	return response.status === 302 && response.headers.get("location") === REDIRECTED_TO_HOME_PAGE;
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
			'Cookie': `JSESSIONID=${initialJSESSIONID}`,
		}
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

async function applyAllActivities(JSESSIONID: string, proxy: Fetcher, kv: KVNamespace, discordWebhook: string) {
	let activities = JSON.parse((await kv.get('unappliedActivities')) as string) as ActivityKV['unappliedActivities'];
	console.log(activities)
	const successfulActivities = JSON.parse((await kv.get('appliedActivities')) ?? '{}') as ActivityKV['appliedActivities'];
	console.log(successfulActivities)
	activities = Object.fromEntries(Object.entries(activities).filter(([id]) => !successfulActivities[id]));
	// console.log('Activities', activities);
	const activityIds = Object.keys(activities);
	const responses = await applySelectedActivities(JSESSIONID, activityIds, proxy);
	const embeds = [];
	let failed = 0;
	let full = 0;
	console.log(responses)
	for (const response of responses) {
		if (response.result !== "false") {
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
   console.log(chunk);
		const res = await fetch(discordWebhook, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				...annouceNewApplyEmbedBody,
				embeds: chunk,
				content: "Successfully applied to " + (activityIds.length - failed) + " activities, failed to apply to " + failed + " activities, " + full + " activities are full.",
			})
		});
    if (!res.is_ok()) throw new Error(res)
	}

	console.log(
		{
			...annouceNewApplyEmbedBody,
			embeds: embeds,
			content: "Successfully applied to " + (activityIds.length - failed) + " activities, failed to apply to " + failed + " activities, " + full + " activities are full.",
		}
	)
}

function sendSuccessfulApplyDiscordWebhook(discordWebhook: string, activity: Activity) {
	return customContentActivityEmbed('✅ Successfully applied to activity!', activity)
}

function sendUnableToApplyDiscordWebhook(discordWebhook: string, activity: Activity, response_text: string) {
	return customContentActivityEmbed('❌ Unable to apply to activity!\n' + response_text, activity)
}

function sendFailedApplyDiscordWebhook(discordWebhook: string, activity: Activity, response_text: string) {
	return customContentActivityEmbed('❌ Failed to apply to activity!\n' + response_text, activity)
}

async function getActivityList(JSESSIONID: string, proxy: Fetcher) {
	const response = await proxy.fetch(ACTIVITY_LIST_PAGE, {
		method: 'GET',
		headers: {
			Cookie: `JSESSIONID=${JSESSIONID}`,
		},
	});
	const activitiesId = getActivityListByHtml(await response.text());
	return await Promise.all(
		activitiesId.map(async (activityId) => {
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
		}),
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
	await sendScanDiscordWebhook(discordWebhook, mapped)
}

async function sendScanDiscordWebhook(discordWebhook: string, newActivities: ActivitiesResponse) {
	const embeds = newActivities.map(buildActivityEmbed);

	console.log(
		{
			...annouceNewApplyEmbedBody,
			embeds: embeds,
		}
	)
	for (const chunk of chunks(embeds, 5)) {
   console.log(chunk)
		const res = await fetch(discordWebhook, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				...annouceNewApplyEmbedBody,
				embeds: chunk,
			})
		});
   if (!res.is_ok()) throw new Error(res);
	}

}

function customContentActivityEmbed(content: string, activity: Activity) {
	return {
		...buildActivityEmbed(activity),
		title: content + activity.activity,
	}
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
			url: 'https://sda.tsu.ac.th/' + activity.banner_path,
		},
		timestamp: new Date().toISOString(),
	};
}

const annouceNewApplyEmbedBody = {
	content: 'New activity has appeared!',
	embeds: [],
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
