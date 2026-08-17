import { describe, it, expect } from 'vitest';
import { parseSdaDate, isWithinRegistrationRange, findImminentActivities, type Activity } from '../src/index';

const makeActivity = (start_date: string, end_date: string) => ({ id: 1, start_date, end_date }) as Activity;

describe('parseSdaDate', () => {
	it('parses the observed SDA format (Thai month, Buddhist Era year, Asia/Bangkok time)', () => {
		// "16 ก.ค. 2569 08:00" (BE 2569 = CE 2026, Asia/Bangkok UTC+7) = 2026-07-16T08:00:00+07:00
		expect(parseSdaDate('16 ก.ค.  2569 08:00')?.toISOString()).toBe('2026-07-16T01:00:00.000Z');
		expect(parseSdaDate('17 ก.ค.  2569 23:59')?.toISOString()).toBe('2026-07-17T16:59:00.000Z');
	});

	it('parses every Thai month abbreviation', () => {
		const months: [string, number][] = [
			['ม.ค.', 0],
			['ก.พ.', 1],
			['มี.ค.', 2],
			['เม.ย.', 3],
			['พ.ค.', 4],
			['มิ.ย.', 5],
			['ก.ค.', 6],
			['ส.ค.', 7],
			['ก.ย.', 8],
			['ต.ค.', 9],
			['พ.ย.', 10],
			['ธ.ค.', 11],
		];
		for (const [abbr, monthIndex] of months) {
			// 15 <month> 2569 12:00 ICT = Date.UTC(2026, month, 15, 5, 0)
			expect(parseSdaDate(`15 ${abbr} 2569 12:00`)?.toISOString()).toBe(new Date(Date.UTC(2026, monthIndex, 15, 5)).toISOString());
		}
	});

	it('parses full Thai month names and dot-less abbreviations', () => {
		expect(parseSdaDate('1 มกราคม 2569 00:00')?.toISOString()).toBe('2025-12-31T17:00:00.000Z');
		expect(parseSdaDate('5 สิงหาคม 2569 09:30')?.toISOString()).toBe('2026-08-05T02:30:00.000Z');
		expect(parseSdaDate('16 กค 2569 08:00')?.toISOString()).toBe('2026-07-16T01:00:00.000Z');
	});

	it('converts Buddhist Era years and leaves Gregorian years alone', () => {
		expect(parseSdaDate('16 ก.ค. 2569 08:00')?.toISOString()).toBe('2026-07-16T01:00:00.000Z');
		expect(parseSdaDate('16 ก.ค. 2026 08:00')?.toISOString()).toBe('2026-07-16T01:00:00.000Z');
	});

	it('supports seconds and dot time separators', () => {
		expect(parseSdaDate('16 ก.ค. 2569 08:00:30')?.toISOString()).toBe('2026-07-16T01:00:30.000Z');
	});

	it('returns null for unparseable input', () => {
		expect(parseSdaDate('')).toBeNull();
		expect(parseSdaDate('not a date')).toBeNull();
		expect(parseSdaDate('16 Foo 2569 08:00')).toBeNull();
		expect(parseSdaDate('16 ก.ค. 2569')).toBeNull();
	});
});

describe('isWithinRegistrationRange', () => {
	const activity = { id: 1, start_date: '16 ก.ค.  2569 08:00', end_date: '17 ก.ค.  2569 23:59' } as Activity;

	it('is true when now is inside the registration window (inclusive bounds)', () => {
		expect(isWithinRegistrationRange(activity, new Date('2026-07-16T01:00:00.000Z'))).toBe(true); // exactly at open
		expect(isWithinRegistrationRange(activity, new Date('2026-07-17T16:59:00.000Z'))).toBe(true); // exactly at close
		expect(isWithinRegistrationRange(activity, new Date('2026-07-17T00:00:00.000Z'))).toBe(true);
	});

	it('is false outside the registration window', () => {
		expect(isWithinRegistrationRange(activity, new Date('2026-07-16T00:59:59.000Z'))).toBe(false); // 1s before open
		expect(isWithinRegistrationRange(activity, new Date('2026-07-17T16:59:01.000Z'))).toBe(false); // 1s after close
	});

	it('fails open when dates cannot be parsed, so a format change never skips registrations', () => {
		expect(isWithinRegistrationRange({ id: 2, start_date: 'unknown', end_date: 'unknown' } as Activity, new Date())).toBe(true);
	});

	it('fails open for string-valued KV entries (leaked result_text values)', () => {
		expect(isWithinRegistrationRange('กลุ่มนี้เต็มแล้ว' as unknown as Activity, new Date())).toBe(true);
	});
});

describe('findImminentActivities', () => {
	// 2026-08-17T16:00:00.000Z = 17 ส.ค. 2569 23:00 Asia/Bangkok
	const now = new Date('2026-08-17T16:00:00.000Z');
	const THRESHOLD = 5 * 60 * 1000;

	it('finds activities opening within the threshold, sorted earliest first', () => {
		const activities = {
			'2': { id: 2, start_date: '17 ส.ค. 2569 23:05', end_date: '18 ส.ค. 2569 23:59' }, // 5 min: threshold inclusive
			'1': { id: 1, start_date: '17 ส.ค. 2569 23:03', end_date: '18 ส.ค. 2569 23:59' }, // 3 min away
		} as unknown as Record<string, Activity>;
		const result = findImminentActivities(activities, now, THRESHOLD);
		expect(result.map((r) => r.id)).toEqual(['1', '2']);
		// openAtMs carries the skew buffer on top of the parsed opening time
		expect(result[0].openAtMs).toBe(parseSdaDate('17 ส.ค. 2569 23:03')!.getTime() + 1000);
	});

	it('excludes activities that already opened or open beyond the threshold', () => {
		const activities = {
			alreadyOpen: { id: 3, start_date: '17 ส.ค. 2569 22:55', end_date: '18 ส.ค. 2569 23:59' },
			tooFarAway: { id: 4, start_date: '17 ส.ค. 2569 23:06', end_date: '18 ส.ค. 2569 23:59' },
		} as unknown as Record<string, Activity>;
		expect(findImminentActivities(activities, now, THRESHOLD)).toEqual([]);
	});

	it('skips unparseable dates and string-valued KV entries instead of throwing', () => {
		const activities = {
			garbage: { id: 5, start_date: '???', end_date: '???' },
			leakedString: 'กลุ่มนี้เต็มแล้ว',
		} as unknown as Record<string, Activity>;
		expect(findImminentActivities(activities, now, THRESHOLD)).toEqual([]);
	});

	it('is empty when there is nothing to wait for', () => {
		expect(findImminentActivities({}, now, THRESHOLD)).toEqual([]);
	});
});
