const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateFanState, createThermostat } = require('../fanThermostat');

// --- evaluateFanState (pure) ---
// Above the band → ON
assert.strictEqual(
	evaluateFanState({ temperature: 26.1, targetTemp: 25, hysteresis: 1, fanOn: false }),
	true, 'above band turns fan on');
// Below the band → OFF
assert.strictEqual(
	evaluateFanState({ temperature: 23.9, targetTemp: 25, hysteresis: 1, fanOn: true }),
	false, 'below band turns fan off');
// Inside the band → keep current state (both directions)
assert.strictEqual(
	evaluateFanState({ temperature: 25.5, targetTemp: 25, hysteresis: 1, fanOn: true }),
	true, 'inside band keeps ON');
assert.strictEqual(
	evaluateFanState({ temperature: 24.5, targetTemp: 25, hysteresis: 1, fanOn: false }),
	false, 'inside band keeps OFF');
// Exact boundaries belong to the band edges
assert.strictEqual(
	evaluateFanState({ temperature: 26, targetTemp: 25, hysteresis: 1, fanOn: false }),
	true, 'temp == target+hyst turns on');
assert.strictEqual(
	evaluateFanState({ temperature: 24, targetTemp: 25, hysteresis: 1, fanOn: true }),
	false, 'temp == target-hyst turns off');
// Bad data → hold state
assert.strictEqual(
	evaluateFanState({ temperature: NaN, targetTemp: 25, hysteresis: 1, fanOn: true }),
	true, 'NaN holds state');
assert.strictEqual(
	evaluateFanState({ temperature: undefined, targetTemp: 25, hysteresis: 1, fanOn: false }),
	false, 'undefined holds state');

// --- createThermostat (stateful wrapper) ---
const tmpSettings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fanauto-')), 'fan-auto.json');
let onCalls = 0, offCalls = 0;
const t = createThermostat({
	fanOn: () => onCalls++,
	fanOff: () => offCalls++,
	settingsPath: tmpSettings,
	log: () => {},
});

// Defaults: disabled, 25°C
assert.deepStrictEqual(t.getState(), { enabled: false, targetTemp: 25, fanOn: false });

// Disabled → tick does nothing even when hot
t.tick(30);
assert.strictEqual(onCalls, 0, 'disabled thermostat never commands the fan');

// Invalid settings rejected
assert.strictEqual(t.applySettings({ enabled: true, targetTemp: 99 }), false, 'targetTemp > 35 rejected');
assert.strictEqual(t.applySettings({ enabled: 'yes', targetTemp: 25 }), false, 'non-boolean rejected');
assert.strictEqual(t.applySettings(null), false, 'null rejected');

// Valid settings applied + persisted
assert.strictEqual(t.applySettings({ enabled: true, targetTemp: 24 }), true);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(tmpSettings, 'utf8')),
	{ enabled: true, targetTemp: 24 }, 'settings persisted to disk');

// Hot → one fanOn command; staying hot → no repeat command
t.tick(26);
assert.strictEqual(onCalls, 1, 'fan commanded on');
t.tick(27);
assert.strictEqual(onCalls, 1, 'no repeated command while already on');
assert.strictEqual(t.getState().fanOn, true);

// Cooled below band → one fanOff
t.tick(22.9);
assert.strictEqual(offCalls, 1, 'fan commanded off');

// Turn fan on again, then DISABLING the system forces the fan off
t.tick(26);
assert.strictEqual(onCalls, 2);
t.applySettings({ enabled: false, targetTemp: 24 });
assert.strictEqual(offCalls, 2, 'disabling auto mode shuts the fan off');
assert.deepStrictEqual(t.getState(), { enabled: false, targetTemp: 24, fanOn: false });

// A new instance reloads persisted settings from disk
const t2 = createThermostat({ fanOn: () => {}, fanOff: () => {}, settingsPath: tmpSettings, log: () => {} });
assert.strictEqual(t2.getState().targetTemp, 24, 'settings reload after restart');

console.log('fanThermostat: all tests passed');
