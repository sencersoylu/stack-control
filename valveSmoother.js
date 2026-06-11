// Valf açı komutlarını yumuşatır: EMA (üstel yumuşatma) + saniyede maksimum
// adım sınırı. Kontrol döngüsü 1 Hz çalıştığı için "adım" = "derece/saniye".
//
// Güvenlik: 0° (tam kapalı) ve ≥90° (tam açık) komutları yumuşatılmaz —
// duraklatma/seans sonu gibi anlık kapanması gereken yollar her zaman anında
// uygulanır. Bu kontrol çağıran tarafta da (instant bayrağı) vardır; burada
// ikinci bir emniyet katmanıdır.

const EMA_ALPHA = 0.35; // gürültü bastırma; tek ayar noktası maxStep olsun diye sabit
const SNAP_THRESHOLD = 0.5; // hedefe bu kadar yaklaşınca kilitlen (sonsuz yaklaşmayı önler)

/**
 * Bir sonraki valf açısını hesaplar.
 * @param {number} current  son komutlanan açı (derece)
 * @param {number} target   istenen açı (derece, 0-90 aralığına çağıran taraf kırpar)
 * @param {number} maxStep  saniyede izin verilen maksimum değişim (derece); <=0 → yumuşatma kapalı
 * @returns {number} komutlanacak açı
 */
function smoothAngle(current, target, maxStep) {
	if (!(maxStep > 0)) return target; // özellik kapalı
	if (target <= 0 || target >= 90) return target; // güvenlik uçları anında

	const filtered = current + EMA_ALPHA * (target - current);
	let step = filtered - current;
	if (step > maxStep) step = maxStep;
	if (step < -maxStep) step = -maxStep;

	const next = current + step;
	if (Math.abs(target - next) <= SNAP_THRESHOLD) return target;
	return next;
}

module.exports = { smoothAngle, EMA_ALPHA, SNAP_THRESHOLD };
