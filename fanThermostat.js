/**
 * Sıcaklık kontrollü otomatik fan (termostat).
 * Karar mantığı saf fonksiyonda (evaluateFanState) — test edilebilir.
 * Tasarım: stack-flow/docs/superpowers/specs/2026-06-10-auto-fan-design.md
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = { enabled: false, targetTemp: 25 };
const HYSTERESIS = 1; // °C, hedefin her iki yanında
const MIN_TARGET = 18;
const MAX_TARGET = 35;

// Histerezisli karar: bant üstünde AÇ, bant altında KAPAT, bant içinde durumu koru.
// Geçersiz sıcaklıkta (NaN/undefined) mevcut durumu döndürür — kötü veriyle karar yok.
function evaluateFanState({ temperature, targetTemp, hysteresis, fanOn }) {
	if (typeof temperature !== 'number' || Number.isNaN(temperature)) return fanOn;
	if (temperature >= targetTemp + hysteresis) return true;
	if (temperature <= targetTemp - hysteresis) return false;
	return fanOn;
}

function createThermostat({ fanOn, fanOff, settingsPath, log = console.log }) {
	const file = settingsPath || path.join(__dirname, 'config', 'fan-auto.json');
	let settings = { ...DEFAULTS };
	let fanState = false; // backend'in PLC'ye verdiği son komut

	try {
		const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (typeof loaded.enabled === 'boolean') settings.enabled = loaded.enabled;
		if (typeof loaded.targetTemp === 'number') settings.targetTemp = loaded.targetTemp;
	} catch (e) {
		/* dosya yoksa varsayılanlar */
	}

	function persist() {
		try {
			fs.writeFileSync(file, JSON.stringify(settings));
		} catch (e) {
			log('fanAuto: ayar kaydedilemedi:', e.message);
		}
	}

	function setFan(next) {
		if (next === fanState) return;
		fanState = next;
		log('fanAuto: fan', next ? 'ON' : 'OFF');
		if (next) fanOn();
		else fanOff();
	}

	return {
		// chamberControl {type:'fanAuto'} verisini doğrula + uygula + kalıcı kaydet.
		// Geçersiz mesaj mevcut ayarı bozmaz (false döner).
		applySettings(data) {
			if (
				!data ||
				typeof data.enabled !== 'boolean' ||
				typeof data.targetTemp !== 'number' ||
				Number.isNaN(data.targetTemp) ||
				data.targetTemp < MIN_TARGET ||
				data.targetTemp > MAX_TARGET
			) {
				log('fanAuto: geçersiz ayar yok sayıldı:', JSON.stringify(data));
				return false;
			}
			settings = { enabled: data.enabled, targetTemp: data.targetTemp };
			persist();
			log('fanAuto: ayar', JSON.stringify(settings));
			// Sistem kapatılırken fan açık kalmasın — manuel kontrol artık yok.
			if (!settings.enabled) setFan(false);
			return true;
		},

		// Ölçüm döngüsünden her saniye çağrılır.
		tick(temperature) {
			if (!settings.enabled) return;
			setFan(
				evaluateFanState({
					temperature,
					targetTemp: settings.targetTemp,
					hysteresis: HYSTERESIS,
					fanOn: fanState,
				})
			);
		},

		isEnabled: () => settings.enabled,
		// sensorData'ya eklenen alan — tüm tabletlere yayınlanır.
		getState: () => ({ ...settings, fanOn: fanState }),
	};
}

module.exports = { evaluateFanState, createThermostat };
