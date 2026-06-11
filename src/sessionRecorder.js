// src/sessionRecorder.js
// Seans geçmişi kaydedicisi. Kontrol döngüsünden çağrılır; HİÇBİR hata
// dışarı fırlatılmaz (kayıt < kontrol). Örnekler bellekte birikir,
// 60 sn'de bir DB'ye yazılır; olaylar anında yazılır.
const db = require('./models');

const SAMPLE_INTERVAL_S = 10;
const FLUSH_INTERVAL_S = 60;

let current = null; // { id, samples: [], events: [], lastFlushT: 0 }

async function persist() {
	if (!current) return;
	await db.sessions.update(
		{ samples: current.samples, events: current.events },
		{ where: { id: current.id } },
	);
}

module.exports = {
	// Açılışta yarım kalan kayıtları kapat (elektrik kesintisi / restart)
	async closeInterrupted() {
		try {
			const [n] = await db.sessions.update(
				{ status: 'interrupted', endTime: new Date() },
				{ where: { endTime: null } },
			);
			if (n > 0) console.log(`[recorder] ${n} interrupted session(s) closed`);
		} catch (err) {
			console.error('[recorder] closeInterrupted:', err.message);
		}
	},

	async startRecording({ targetPressure, duration, speed, profile }) {
		try {
			// Profili 10 sn'e seyrelt, [t, bar] olarak sakla
			const slimProfile = (Array.isArray(profile) ? profile : [])
				.filter((p, i) => i % SAMPLE_INTERVAL_S === 0 || i === profile.length - 1)
				.map((p) => [p[0], p[1]]);
			const row = await db.sessions.create({
				startTime: new Date(),
				status: 'running',
				targetPressure,
				duration,
				speed,
				profile: slimProfile,
				samples: [],
				events: [],
			});
			current = { id: row.id, samples: [], events: [], lastFlushT: 0 };
			console.log('[recorder] session', row.id, 'recording started');
		} catch (err) {
			console.error('[recorder] startRecording:', err.message);
			current = null;
		}
	},

	// Her saniye çağrılır; 10 sn'de bir örnek alır, 60 sn'de bir flush eder.
	addSample(t, hedefBar, pressure, temperature, humidity, o2) {
		if (!current) return;
		try {
			if (t % SAMPLE_INTERVAL_S !== 0) return;
			const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
			current.samples.push([
				t,
				r2(hedefBar),
				r2(pressure),
				r2(temperature),
				r2(humidity),
				r2(o2),
			]);
			if (t - current.lastFlushT >= FLUSH_INTERVAL_S) {
				current.lastFlushT = t;
				persist().catch((err) =>
					console.error('[recorder] flush:', err.message),
				);
			}
		} catch (err) {
			console.error('[recorder] addSample:', err.message);
		}
	},

	addEvent(type, t, reason) {
		if (!current) return;
		try {
			const ev = { type, t };
			if (reason) ev.reason = reason;
			current.events.push(ev);
			persist().catch((err) =>
				console.error('[recorder] event flush:', err.message),
			);
		} catch (err) {
			console.error('[recorder] addEvent:', err.message);
		}
	},

	async stopRecording(status) {
		if (!current) return;
		const id = current.id;
		try {
			await persist();
			await db.sessions.update(
				{ status, endTime: new Date() },
				{ where: { id } },
			);
			console.log('[recorder] session', id, 'finished:', status);
		} catch (err) {
			console.error('[recorder] stopRecording:', err.message);
		} finally {
			current = null;
		}
	},

	isRecording() {
		return current !== null;
	},
};
