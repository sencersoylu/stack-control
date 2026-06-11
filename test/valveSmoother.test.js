const assert = require('assert');
const { smoothAngle } = require('../valveSmoother');

// maxStep <= 0 → yumuşatma kapalı, hedef olduğu gibi döner
assert.strictEqual(smoothAngle(10, 18, 0), 18, 'maxStep 0 passthrough');
assert.strictEqual(smoothAngle(10, 18, -1), 18, 'negatif maxStep passthrough');

// Güvenlik uçları anında: 0° ve ≥90°
assert.strictEqual(smoothAngle(45, 0, 2), 0, 'kapatma anında');
assert.strictEqual(smoothAngle(45, 90, 2), 90, 'tam açma anında');
assert.strictEqual(smoothAngle(45, 120, 2), 120, '90 üstü anında (çağıran kırpar)');

// Büyük sıçrama adım sınırına takılır: 12→18, maxStep 2 → ilk adım +2
assert.strictEqual(smoothAngle(12, 18, 2), 14, 'adım yukarı sınırlı');
assert.strictEqual(smoothAngle(18, 12, 2), 16, 'adım aşağı sınırlı');

// Küçük fark EMA ile yumuşar: 14→15, alpha 0.35 → 0.35 adım... ama snap
// eşiği 0.5 olduğu için |15 - 14.35| = 0.65 > 0.5 → 14.35 döner
assert.ok(Math.abs(smoothAngle(14, 15, 2) - 14.35) < 1e-9, 'EMA küçük adım');

// Hedefe yaklaşınca kilitlenir: 14.8→15 → |15-14.87| <= 0.5 → 15
assert.strictEqual(smoothAngle(14.8, 15, 2), 15, 'snap hedefe kilitlenir');

// Yakınsama: 12'den 18'e tekrarlı çağrıyla sonlu adımda ulaşır
let angle = 12;
let iterations = 0;
while (angle !== 18 && iterations < 30) {
	angle = smoothAngle(angle, 18, 2);
	iterations++;
}
assert.strictEqual(angle, 18, 'hedefe yakınsar');
assert.ok(iterations >= 3, `geçiş yumuşak olmalı (${iterations} adım)`);
assert.ok(iterations <= 10, `geçiş makul sürede bitmeli (${iterations} adım)`);

// Gürültü bastırma: hedef 12↔18 arasında zıplarken çıktı tam bandı takip etmez
let noisy = 15;
const outputs = [];
for (let i = 0; i < 10; i++) {
	noisy = smoothAngle(noisy, i % 2 === 0 ? 12 : 18, 2);
	outputs.push(noisy);
}
const span = Math.max(...outputs) - Math.min(...outputs);
assert.ok(span < 4, `çıktı salınımı ham banttan (6°) dar olmalı: ${span.toFixed(2)}°`);

console.log('valveSmoother: all tests passed');
