class SensorCalibration {
	constructor(point1, point2, point3) {
		// Her nokta {raw: ham_değer, actual: gerçek_değer} formatında olmalı
		this.points = [point1, point2, point3];
		this.validatePoints();
		this.coefficients = this.calculateCoefficients();
	}

	validatePoints() {
		if (this.points.length !== 3) {
			throw new Error('Tam olarak 3 nokta gereklidir');
		}

		for (let i = 0; i < this.points.length; i++) {
			if (
				!this.points[i].hasOwnProperty('raw') ||
				!this.points[i].hasOwnProperty('actual')
			) {
				throw new Error(
					`Nokta ${i + 1} için 'raw' ve 'actual' değerleri gereklidir`
				);
			}
		}

		// Ham değerlerin farklı olup olmadığını kontrol et
		const rawValues = this.points.map((p) => p.raw);
		if (new Set(rawValues).size !== 3) {
			throw new Error('Ham değerler birbirinden farklı olmalıdır');
		}
	}

	// 2. derece polinom katsayılarını hesapla (y = ax² + bx + c)
	calculateCoefficients() {
		const [p1, p2, p3] = this.points;
		const [x1, y1] = [p1.raw, p1.actual];
		const [x2, y2] = [p2.raw, p2.actual];
		const [x3, y3] = [p3.raw, p3.actual];

		// Vandermonde matrisi çözümü
		const denominator = (x1 - x2) * (x1 - x3) * (x2 - x3);

		if (Math.abs(denominator) < 1e-10) {
			throw new Error('Noktalar doğrusal olarak bağımlı - çözüm bulunamaz');
		}

		const a = (x3 * (y2 - y1) + x2 * (y1 - y3) + x1 * (y3 - y2)) / denominator;
		const b =
			(x3 * x3 * (y1 - y2) + x2 * x2 * (y3 - y1) + x1 * x1 * (y2 - y3)) /
			denominator;
		const c =
			(x2 * x3 * (x2 - x3) * y1 +
				x3 * x1 * (x3 - x1) * y2 +
				x1 * x2 * (x1 - x2) * y3) /
			denominator;

		return { a, b, c };
	}

	// Ham değeri gerçek değere çevir
	calibrate(rawValue) {
		const { a, b, c } = this.coefficients;
		return a * rawValue * rawValue + b * rawValue + c;
	}

	// Lineer interpolasyon (basit yaklaşım)
	linearInterpolation(rawValue) {
		// En yakın iki noktayı bul
		const sortedPoints = [...this.points].sort((a, b) => a.raw - b.raw);

		if (rawValue <= sortedPoints[0].raw) {
			// Alt sınırın altında - en yakın iki nokta kullan
			return this.interpolateBetween(
				sortedPoints[0],
				sortedPoints[1],
				rawValue
			);
		} else if (rawValue >= sortedPoints[2].raw) {
			// Üst sınırın üstünde - en yakın iki nokta kullan
			return this.interpolateBetween(
				sortedPoints[1],
				sortedPoints[2],
				rawValue
			);
		} else {
			// Aralık içinde - uygun iki nokta bul
			for (let i = 0; i < sortedPoints.length - 1; i++) {
				if (
					rawValue >= sortedPoints[i].raw &&
					rawValue <= sortedPoints[i + 1].raw
				) {
					return this.interpolateBetween(
						sortedPoints[i],
						sortedPoints[i + 1],
						rawValue
					);
				}
			}
		}
	}

	interpolateBetween(point1, point2, rawValue) {
		const ratio = (rawValue - point1.raw) / (point2.raw - point1.raw);
		return point1.actual + ratio * (point2.actual - point1.actual);
	}

	// Kalibrasyon doğruluğunu test et
	testAccuracy() {
		console.log('Kalibrasyon Test Sonuçları:');
		console.log('Nokta\tHam\tGerçek\tPolinom\tLineer\tPol.Hata\tLin.Hata');

		this.points.forEach((point, index) => {
			const polynomResult = this.calibrate(point.raw);
			const linearResult = this.linearInterpolation(point.raw);
			const polynomError = Math.abs(polynomResult - point.actual);
			const linearError = Math.abs(linearResult - point.actual);

			console.log(
				`${index + 1}\t${point.raw}\t${point.actual}\t${polynomResult.toFixed(
					4
				)}\t${linearResult.toFixed(4)}\t${polynomError.toFixed(
					6
				)}\t${linearError.toFixed(6)}`
			);
		});
	}

	// Katsayıları göster
	getCoefficients() {
		return this.coefficients;
	}

	// Kalibrasyon eğrisini çiz (konsol çıktısı)
	plotCalibration(minRaw, maxRaw, steps = 20) {
		console.log('\nKalibrasyon Eğrisi:');
		console.log('Ham Değer\tPolinom Sonuç\tLineer Sonuç');

		const stepSize = (maxRaw - minRaw) / steps;
		for (let i = 0; i <= steps; i++) {
			const rawValue = minRaw + i * stepSize;
			const polynomResult = this.calibrate(rawValue);
			const linearResult = this.linearInterpolation(rawValue);
			console.log(
				`${rawValue.toFixed(2)}\t\t${polynomResult.toFixed(
					4
				)}\t\t${linearResult.toFixed(4)}`
			);
		}
	}
}

module.exports = SensorCalibration;
