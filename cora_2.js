const net = require('net');
require('dotenv').config();
const express = require('express');

const app = express();
const http = require('http');
const { io } = require('socket.io-client');
const cors = require('cors');
const { linearConversion } = require('./src/helpers');
const db = require('./src/models');
const demo = 0;
const { ProfileUtils, ProfileManager } = require('./profile_manager');
const dayjs = require('dayjs');
let server = http.Server(app);
const bodyParser = require('body-parser');
const exporter = require('highcharts-export-server');

const connections = []; // view soket bağlantılarının tutulduğu array
let isWorking = 0;
let isConnectedPLC = 0;
let sensorCalibrationData = {}; // Object to store all sensor calibration data
let demoMode = 0;

db.sequelize.sync({});

init();
const allRoutes = require('./src/routes');

let sensorData = {};

let o2Timer = null;

let socket = null;
app.use(cors());
app.use(bodyParser.json());
app.use(
	bodyParser.urlencoded({
		extended: true,
	})
);
app.use(allRoutes);

let sessionStatus = {
	status: 0, // 0: session durumu yok, 1: session başlatıldı, 2: session duraklatıldı, 3: session durduruldu
	zaman: 0,
	dalisSuresi: 10,
	cikisSuresi: 10,
	hedeflenen: [],
	cikis: 0,
	grafikdurum: 0,
	adim: 0,
	adimzaman: [],
	maxadim: [],
	hedef: 0,
	lastdurum: 0,
	wait: 0,
	p2counter: 0,
	tempadim: 0,
	profile: [],
	minimumvalve: 12,
	otomanuel: 0,
	alarmzaman: 0,
	diffrencesayac: 0,
	higho: 0,
	highoc: 0,
	higho2: 0,
	pauseTime: 0,
	starttime: 0,
	pausetime: 0,
	ilksure: 0,
	ilkfsw: 0,
	fswd: 0,
	pauseDepteh: 0,
	doorSensorStatus: 0,
	doorStatus: 0,
	pressure: 0,

	o2: 0,
	bufferdifference: [],
	olcum: [],
	ventil: 0,
	main_fsw: 0,
	pcontrol: 0,
	comp_offset: 12,
	comp_gain: 8,
	comp_depth: 100,
	decomp_offset: 14,
	decomp_gain: 7,
	decomp_depth: 100,
	chamberStatus: 1,
	chamberStatusText: '',
	chamberStatusTime: null,
	setDerinlik: 0,
	dalisSuresi: 0,
	cikisSuresi: 0,
	toplamSure: 0,
	eop: 0,
	uyariyenile: 0,
	uyariyenile: 0,
	// Oksijen molası için eklenen değişkenler
	duzGrafikBaslangicZamani: 0, // Düz grafik durumunun başladığı zaman
	sonOksijenMolasi: 0, // Son oksijen molası verildiği zaman
	oksijenMolasiAktif: false, // Oksijen molası uyarısının aktif olup olmadığı
	sessionStartTime: dayjs(),
};

// Make sessionStatus globally accessible
global.sessionStatus = sessionStatus;

let alarmStatus = {
	status: 0,
	type: '',
	text: '',
	time: 0,
	duration: 0,
};

async function init() {
	console.log('**************** APP START ****************');

	app.use(cors());
	app.use(bodyParser.json());
	app.use(
		bodyParser.urlencoded({
			extended: true,
		})
	);

	// ***********************************************************
	// ***********************************************************
	// SERVER CONFIGS
	// ***********************************************************
	// ***********************************************************
	server.listen(4001, () => console.log(`Listening on port 4001`));

	await loadSensorCalibrationData();

	try {
		socket = io.connect('http://localhost:4000', { reconnect: true });
		socket.on('connect', function () {
			console.log('Connected to server');
			doorOpen();
			compValve(0);
			decompValve(0);
			sessionStartBit(0);

			setInterval(() => {
				liveBit();
			}, 3000);

			//socket.emit('writeRegister', JSON.stringify({address: "R03904", value: 8000}));
		});
		socket.on('disconnect', function () {
			console.log('Disconnected from server');
		});
		socket.on('data', async function (data) {
			if (demoMode == 1) {
				return;
			}
			console.log('Received message:', data);
			const dataObject = JSON.parse(data);
			//console.log("length",dataObject.data.length);
			if (dataObject.data.length > 1) {
				sessionStatus.doorSensorStatus = dataObject.data[10];

				sensorData['pressure'] = linearConversion(
					sensorCalibrationData['pressure'].sensorLowerLimit,
					sensorCalibrationData['pressure'].sensorUpperLimit,
					sensorCalibrationData['pressure'].sensorAnalogLower,
					sensorCalibrationData['pressure'].sensorAnalogUpper,
					dataObject.data[1],
					sensorCalibrationData['pressure'].sensorDecimal
				);
				sessionStatus.pressure = sensorData['pressure'];
				sessionStatus.main_fsw = sensorData['pressure'] * 33.4;

				sensorData['o2'] = 21.1;

				sensorData['temperature'] = linearConversion(
					sensorCalibrationData['temperature'].sensorLowerLimit,
					sensorCalibrationData['temperature'].sensorUpperLimit,
					sensorCalibrationData['temperature'].sensorAnalogLower,
					sensorCalibrationData['temperature'].sensorAnalogUpper,
					dataObject.data[4],
					sensorCalibrationData['temperature'].sensorDecimal
				);

				sensorData['humidity'] = linearConversion(
					sensorCalibrationData['humidity'].sensorLowerLimit,
					sensorCalibrationData['humidity'].sensorUpperLimit,
					sensorCalibrationData['humidity'].sensorAnalogLower,
					sensorCalibrationData['humidity'].sensorAnalogUpper,
					dataObject.data[5],
					sensorCalibrationData['humidity'].sensorDecimal
				);

				if (dataObject.data[1] < 2000) {
					sessionStatus.chamberStatus = 0;
					sessionStatus.chamberStatusText = 'Pressure sensor problem';
					sessionStatus.chamberStatusTime = dayjs().format(
						'YYYY-MM-DD HH:mm:ss'
					);
				} else if (dataObject.data[4] < 2000) {
					sessionStatus.chamberStatus = 0;
					sessionStatus.chamberStatusText = 'Temperature sensor problem';
					sessionStatus.chamberStatusTime = dayjs().format(
						'YYYY-MM-DD HH:mm:ss'
					);
				} else if (dataObject.data[5] < 2000) {
					sessionStatus.chamberStatus = 0;
					sessionStatus.chamberStatusText = 'Humidity sensor problem';
					sessionStatus.chamberStatusTime = dayjs().format(
						'YYYY-MM-DD HH:mm:ss'
					);
				} else {
					sessionStatus.chamberStatus = 1;
					sessionStatus.chamberStatusText = 'Chamber is ready';
					sessionStatus.chamberStatusTime = dayjs().format(
						'YYYY-MM-DD HH:mm:ss'
					);
				}
				console.log(
					sessionStatus.chamberStatus,
					sessionStatus.chamberStatusText,
					sessionStatus.chamberStatusTime
				);
			} else {
				console.log('chamberStatus problem');
				sessionStatus.chamberStatus = 0;
				sessionStatus.chamberStatusText =
					'Chamber is communication problem. Please contact to support.';
				sessionStatus.chamberStatusTime = dayjs().format('YYYY-MM-DD HH:mm:ss');
			}

			// Read all sensor calibration data and store in object
		});

		socket.on('chamberControl', function (data) {
			console.log('chamberControl', data);
			const dt = data;
			console.log(dt);
			if (dt.type == 'alarm') {
				if (
					dt.data &&
					dt.data.alarmStatus &&
					typeof dt.data.alarmStatus === 'object'
				) {
					alarmStatus = { ...alarmStatus, ...dt.data.alarmStatus };
				}
			} else if (dt.type == 'alarmClear') {
				alarmClear();
			} else if (dt.type == 'sessionStart') {
				sessionStatus.dalisSuresi = dt.data.dalisSuresi;
				sessionStatus.cikisSuresi = dt.data.cikisSuresi;
				sessionStatus.toplamSure = dt.data.toplamSure;
				sessionStatus.setDerinlik = dt.data.setDerinlik;

				console.log(
					sessionStatus.dalisSuresi,
					sessionStatus.setDerinlik,
					'air'
				);

				// Calculate treatment duration
				const treatmentDuration =
					sessionStatus.toplamSure -
					(sessionStatus.dalisSuresi + sessionStatus.cikisSuresi);

				// Create alternating oxygen/air treatment segments
				const treatmentSegments = createAlternatingTreatmentProfile(
					treatmentDuration,
					sessionStatus.setDerinlik
				);

				// Build complete profile with descent, alternating treatment, and ascent
				const setProfile = [
					[sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air'], // Descent phase
					...treatmentSegments, // Alternating oxygen/air treatment phases
					[sessionStatus.cikisSuresi, 0, 'air'], // Ascent phase
				];

				const quickProfile = ProfileUtils.createQuickProfile(setProfile);
				sessionStatus.profile = quickProfile.toTimeBasedArrayBySeconds();

				console.log(sessionStatus.profile);

				sessionStatus.status = 1;

				socket.emit('chamberControl', {
					type: 'sessionStarting',
					data: {},
				});
				sessionStartBit(1);
				sessionStatus.sessionStartTime = dayjs();
			} else if (dt.type == 'sessionPause') {
				sessionStatus.status = 2;
				sessionStatus.otomanuel = 1;
				sessionStatus.pauseTime = sessionStatus.zaman;
				sessionStatus.pauseDepth = sensorData['pressure'];
				compValve(0);
				decompValve(0);
			} else if (dt.type == 'sessionResume') {
				// Calculate resume parameters
				const pauseEndTime = sessionStatus.zaman;
				const currentPressure = sensorData['pressure'];
				const stepDuration = pauseEndTime - sessionStatus.pauseTime;

				// Call session resume function to recalculate profile
				sessionResume(
					sessionStatus.pauseTime,
					pauseEndTime,
					currentPressure,
					sessionStatus.pauseDepth,
					stepDuration
				);

				sessionStatus.status = 1;
				sessionStatus.otomanuel = 0;

				socket.emit('chamberControl', {
					type: 'sessionResumed',
					data: {
						profile: sessionStatus.profile,
						currentTime: sessionStatus.zaman,
					},
				});
			} else if (dt.type == 'sessionStop') {
				sessionStop();
				socket.emit('chamberControl', {
					type: 'sessionStopped',
					data: {
						profile: sessionStatus.profile,
						currentTime: sessionStatus.zaman,
					},
				});
			} else if (dt.type == 'doorClose') {
				console.log('doorClose');
				doorClose();
			} else if (dt.type == 'doorOpen') {
				console.log('doorOpen');
				doorOpen();
			} else if (dt.type == 'compValve') {
				console.log('CompValve : ', dt.data.vana);
				compValve(dt.data.vana);
			} else if (dt.type == 'decompValve') {
				console.log('deCompValve : ', dt.data.vana);
				decompValve(dt.data.vana);
			} else if (dt.type == 'drainOn') {
				console.log('drainOn');
				drainOn();
			} else if (dt.type == 'drainOff') {
				console.log('drainOff');
				drainOff();
			} else if (dt.type == 'changeSessionPressure') {
				updateTreatmentDepth(dt.data.newDepth);
			} else if (dt.type == 'changeSessionDuration') {
				updateTotalSessionDuration(dt.data.newDuration);
			}
		});

		socket.on('sessionStart', function (data) {
			console.log('sessionStart', data);
			const dt = JSON.parse(data);
			sessionStatus.dalisSuresi = dt.dalisSuresi;
			sessionStatus.cikisSuresi = dt.cikisSuresi;
			sessionStatus.toplamSure = dt.toplamSure;
			sessionStatus.setDerinlik = dt.setDerinlik;
			sessionStatus.status = 1;

			console.log(sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air');

			// Calculate treatment duration
			const treatmentDuration =
				sessionStatus.toplamSure -
				(sessionStatus.dalisSuresi + sessionStatus.cikisSuresi);

			// Create alternating oxygen/air treatment segments
			const treatmentSegments = createAlternatingTreatmentProfile(
				treatmentDuration,
				sessionStatus.setDerinlik
			);

			// Build complete profile with descent, alternating treatment, and ascent
			const setProfile = [
				[sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air'], // Descent phase
				...treatmentSegments, // Alternating oxygen/air treatment phases
				[sessionStatus.cikisSuresi, 0, 'air'], // Ascent phase
			];

			const profile = new ProfileManager();

			const quickProfile = ProfileUtils.createQuickProfile(setProfile);
			console.log(quickProfile);
			sessionStatus.profile = quickProfile.toTimeBasedArrayBySeconds();

			console.log(sessionStatus.profile);
		});

		socket.on('sessionPause', function (data) {
			sessionStatus.status = 2;
			sessionStatus.otomanuel = 1;
			sessionStatus.pauseTime = sessionStatus.zaman;
			sessionStatus.pauseDepth = sensorData['pressure'];
		});

		socket.on('sessionResume', function (data) {
			// Calculate resume parameters
			const pauseEndTime = sessionStatus.zaman;
			const currentPressure = sensorData['pressure'];
			const stepDuration = pauseEndTime - sessionStatus.pauseTime;

			// Call session resume function to recalculate profile
			sessionResume(
				sessionStatus.pauseTime,
				pauseEndTime,
				currentPressure,
				sessionStatus.pauseDepth,
				stepDuration
			);

			sessionStatus.status = 1;
			sessionStatus.otomanuel = 0;
		});

		socket.on('sessionStop', function (data) {
			sessionStop();
		});

		// Removed commented service code
	} catch (err) {
		console.log(err);
	}
}

async function loadSensorCalibrationData() {
	try {
		const allSensors = await db.sensors.findAll({
			attributes: [
				'sensorID',
				'sensorName',
				'sensorText',
				'sensorMemory',
				'sensorSymbol',
				'sensorOffset',
				'sensorLowerLimit',
				'sensorUpperLimit',
				'sensorAnalogUpper',
				'sensorAnalogLower',
				'sensorDecimal',
			],
		});
		allSensors.forEach((sensor) => {
			sensorCalibrationData[sensor.sensorName] = {
				sensorName: sensor.sensorName,
				sensorText: sensor.sensorText,
				sensorMemory: sensor.sensorMemory,
				sensorSymbol: sensor.sensorSymbol,
				sensorOffset: sensor.sensorOffset,
				sensorLowerLimit: Number(sensor.sensorLowerLimit),
				sensorUpperLimit: Number(sensor.sensorUpperLimit),
				sensorAnalogUpper: Number(sensor.sensorAnalogUpper),
				sensorAnalogLower: Number(sensor.sensorAnalogLower),
				sensorDecimal: Number(sensor.sensorDecimal),
			};
		});
		console.log(sensorCalibrationData);
	} catch (error) {
		console.error('Error reading sensor calibration data:', error);
	}
}

setInterval(() => {
	// //read();
	// if (sessionStatus.status == 1) {
	//     sessionStatus.zaman++;
	//     console.log(sessionStatus.zaman);
	//     console.log(sessionStatus.profile[sessionStatus.zaman]);
	// }

	if (demoMode == 0) {
		read();
	} else {
		read_demo();
		socket.emit('sensorData', {
			pressure: sensorData['pressure'],
			o2: sensorData['o2'],
			temperature: sensorData['temperature'],
			humidity: sensorData['humidity'],
			sessionStatus: sessionStatus,
			doorStatus: sessionStatus.doorStatus,
		});
	}
}, 1000);

// Her 3 saniyede bir livebit gönder

function read() {
	// Sensor değerlerini al

	socket.emit('sensorData', {
		pressure: sensorData['pressure'],
		o2: sensorData['o2'],
		temperature: sensorData['temperature'],
		humidity: sensorData['humidity'],
		sessionStatus: sessionStatus,
		doorStatus: sessionStatus.doorStatus,
	});

	console.log(
		sessionStatus.status,
		sessionStatus.zaman,
		sessionStatus.grafikdurum
	);

	if (sessionStatus.status > 0) sessionStatus.zaman++;
	if (sessionStatus.status == 1 && sessionStatus.doorStatus == 0) {
		console.log('door closing');
		alarmSet('sessionStarting', 'Session Starting', 0);
		doorClose();
	}

	// Sistem aktifse kontrol et
	if (
		sessionStatus.status > 0 &&
		sessionStatus.doorStatus == 1 &&
		sessionStatus.zaman > 5
	) {
		// Hedef basıncı belirle
		if (
			sessionStatus.profile.length > sessionStatus.zaman &&
			sessionStatus.profile[sessionStatus.zaman]
		) {
			sessionStatus.hedef =
				sessionStatus.profile[sessionStatus.zaman][1] * 33.4;
		} else if (
			sessionStatus.profile.length > 0 &&
			sessionStatus.profile[sessionStatus.profile.length - 1]
		) {
			sessionStatus.hedef =
				sessionStatus.profile[sessionStatus.profile.length - 1][1] * 33.4;
		} else {
			sessionStatus.hedef = 0;
		}

		// Çıkış durumunda hedefi sıfırla
		if (
			sessionStatus.zaman > sessionStatus.profile.length ||
			sessionStatus.cikis == 1
		) {
			sessionStatus.hedef = 0;
		}
		console.log('hedef : ', sessionStatus.hedef.toFixed(2));

		// Grafik durumunu belirle (yükseliş/iniş/düz)
		sessionStatus.lastdurum = sessionStatus.grafikdurum;

		// Check if current and next profile points exist
		if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.profile[sessionStatus.zaman + 1]
		) {
			if (
				sessionStatus.profile[sessionStatus.zaman][1] >
				sessionStatus.profile[sessionStatus.zaman + 1][1]
			) {
				sessionStatus.grafikdurum = 0; // İniş
			} else if (
				sessionStatus.profile[sessionStatus.zaman][1] <
				sessionStatus.profile[sessionStatus.zaman + 1][1]
			) {
				sessionStatus.grafikdurum = 1; // Çıkış
			} else {
				sessionStatus.grafikdurum = 2; // Düz
			}
		} else {
			// If at end of profile, maintain current state or set to descent
			sessionStatus.grafikdurum = 0; // Default to descent when at end
		}

		// Oksijen molası kontrolü - Düz grafik durumunda
		if (sessionStatus.grafikdurum === 2) {
			// Düz grafik durumunun başlangıcını kaydet
			if (sessionStatus.lastdurum !== 2) {
				sessionStatus.duzGrafikBaslangicZamani = sessionStatus.zaman;
				sessionStatus.sonOksijenMolasi = sessionStatus.zaman;
				console.log(
					'Demo: Düz grafik durumu başladı, oksijen molası timer başlatıldı:',
					sessionStatus.zaman
				);
				alarmSet('oxygenBreak', 'Please wear your oxygen mask. ', 900);
			}

			// Her 15 dakikada (900 saniye) bir oksijen molası uyarısı
			const dakika15Saniye = 15 * 60; // 900 saniye
			const dakika5Saniye = 5 * 60; // 300 saniye
			const gecenSure = sessionStatus.zaman - sessionStatus.sonOksijenMolasi;

			// 15 dakika geçtiyse ve henüz uyarı aktif değilse
			if (
				gecenSure >= dakika15Saniye &&
				!sessionStatus.oksijenMolasiAktif &&
				sessionStatus.cikis == 0
			) {
				alarmSet(
					'oxygenBreak',
					'Please remove your mask for an oxygen break.',
					dakika5Saniye
				);
				sessionStatus.oksijenMolasiAktif = true;
				sessionStatus.sonOksijenMolasi = sessionStatus.zaman;
				console.log(
					'Demo: Oksijen molası uyarısı verildi:',
					sessionStatus.zaman
				);
			}

			// 5 dakika sonra uyarıyı kapatx
			if (
				sessionStatus.oksijenMolasiAktif &&
				sessionStatus.zaman - sessionStatus.sonOksijenMolasi >= dakika5Saniye &&
				sessionStatus.cikis == 0
			) {
				sessionStatus.oksijenMolasiAktif = false;
				console.log(
					'Demo: Oksijen molası uyarısı sona erdi:',
					sessionStatus.zaman
				);
				alarmSet('oxygenBreak', 'Please wear your oxygen mask.', 0);
			}
		} else {
			// Düz durumdan çıkıldığında timer'ları sıfırla
			if (sessionStatus.lastdurum === 2 && sessionStatus.cikis == 0) {
				sessionStatus.duzGrafikBaslangicZamani = 0;
				sessionStatus.oksijenMolasiAktif = false;
				console.log(
					'Demo: Düz grafik durumu sona erdi, oksijen molası timer sıfırlandı:',
					sessionStatus.zaman
				);
				alarmSet(
					'oxygenBreak',
					'Please remove your mask for an oxygen break.',
					0
				);
			}
		}

		// Check if step (adım) has changed
		if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.adim !== sessionStatus.profile[sessionStatus.zaman][2]
		) {
			console.log(
				'Step changed from',
				sessionStatus.adim,
				'to',
				sessionStatus.profile[sessionStatus.zaman][2]
			);
			//alarmSet('stepChange', 'Step Changed', 0);
		}

		// Adım kontrolü
		if (
			sessionStatus.grafikdurum != sessionStatus.lastdurum &&
			sessionStatus.wait == 0
		) {
			sessionStatus.p2counter = 0;
		}

		if (sessionStatus.profile[sessionStatus.zaman]) {
			sessionStatus.adim = sessionStatus.profile[sessionStatus.zaman][2];
		}

		// Gecikme kontrolü - Yükseliş sırasında hedef basınca ulaşılamadıysa
		// if (sessionStatus.main_fsw < sessionStatus.maxadim[sessionStatus.adim] &&
		//     sessionStatus.zaman == (sessionStatus.adimzaman[sessionStatus.adim] * 60 - 2) &&
		//     sessionStatus.grafikdurum == 1 &&
		//     sessionStatus.otomanuel == 0 ) {

		//     sessionStatus.wait = 1;
		//     sessionStatus.waitstarttime = sessionStatus.zaman;
		//     sessionStatus.targetmax = sessionStatus.maxadim[sessionStatus.adim];
		//     sessionStatus.counter = 0;
		//     sessionStatus.tempadim = sessionStatus.adim;
		// }

		// // Gecikme kontrolü - İniş sırasında hedef basıncın üzerindeyse
		// if (sessionStatus.main_fsw > sessionStatus.maxadim[sessionStatus.adim] &&
		//     sessionStatus.zaman == (sessionStatus.adimzaman[sessionStatus.adim] * 60 - 2) &&
		//     sessionStatus.grafikdurum == 0 &&
		//     sessionStatus.otomanuel == 0 ) {

		//     sessionStatus.wait = 2;
		//     sessionStatus.waitstarttime = sessionStatus.zaman;
		//     sessionStatus.targetmax = sessionStatus.maxadim[sessionStatus.adim];
		//     sessionStatus.counter = 0;
		//     sessionStatus.tempadim = sessionStatus.adim;
		// }

		// // Gecikme bitirme kontrolü
		// if (sessionStatus.main_fsw > sessionStatus.targetmax - 0.5 && sessionStatus.wait == 1 && sessionStatus.counter != 0) {
		//     sessionStatus.wait = 0;
		//     sessionStatus.waitstoptime = sessionStatus.zaman;
		//     sessionStatus.p2counter = 0;
		//     //grafikupdate(sessionStatus.adim, sessionStatus.counter);
		//     sessionStatus.adim = sessionStatus.tempadim + 1;
		// }

		// if (sessionStatus.main_fsw < sessionStatus.targetmax + 0.5 && sessionStatus.wait == 2 && sessionStatus.counter != 0) {
		//     sessionStatus.wait = 0;
		//     sessionStatus.p2counter = 0;
		//     sessionStatus.waitstoptime = sessionStatus.zaman + 1;
		//     //grafikupdate(sessionStatus.adim, sessionStatus.counter);
		//     sessionStatus.adim = sessionStatus.tempadim - 1;
		// }

		// Gecikme sırasında hedefi güncelle
		// if (sessionStatus.wait == 1 || sessionStatus.wait == 2) {
		//     if (sessionStatus.wait == 2) sessionStatus.grafikdurum = 0;
		//     sessionStatus.hedeflenen[sessionStatus.zaman + 1] = sessionStatus.targetmax;
		//     sessionStatus.counter++;
		// }

		// Zaman hesaplamaları
		var s = sessionStatus.zaman % 60;
		var m = parseInt(sessionStatus.zaman / 60);

		sessionStatus.p2counter++;

		// Global değişkenleri güncelle
		sessionStatus.fsw = sessionStatus.main_fsw;
		sessionStatus.fswd = sessionStatus.main_fswd;

		// Fark hesaplama
		var difference =
			parseFloat(sessionStatus.hedef) - parseFloat(sessionStatus.main_fsw);
		sessionStatus.bufferdifference[sessionStatus.zaman] = difference;
		sessionStatus.olcum.push(sessionStatus.main_fsw);

		console.log('difference :', difference);

		console.log(
			'pressure :',
			sessionStatus.pressure,
			sessionStatus.fsw.toFixed(2)
		);

		// İlk basınç kaydı
		if (sessionStatus.zaman == 1) {
			sessionStatus.ilkbasinc = sessionStatus.fsw;
		}

		// Uyarı kontrolü
		if (sessionStatus.zaman > 0) {
			// Periyodik uyarılar
			// if (sessionStatus.zaman % sessionStatus.sesliuyari == 0 && sessionStatus.uyaridurum == 0) {
			//     showalert('Operator Shouldnt Away From The Panel !', 0);
			//     sessionStatus.uyaridurum = 1;
			// }
			// if (sessionStatus.zaman % sessionStatus.goreseluyari == 0 && sessionStatus.uyaridurum == 0) {
			//     showalert('Operator Shouldnt Away From The Panel !', 1);
			//     sessionStatus.uyaridurum = 1;
			// }

			// Sapma uyarısı
			if (Math.abs(sessionStatus.bufferdifference[sessionStatus.zaman]) > 5) {
				sessionStatus.diffrencesayac++;
			}

			// if (sessionStatus.diffrencesayac > 10 && sessionStatus.otomanuel == 0 && (sessionStatus.alarmzaman + 300 < sessionStatus.zaman || sessionStatus.alarmzaman == 0)) {
			//     alarmSet('deviation', 'Deviation ! Please Check The Compressor and Air Supply System.', 0);
			//     sessionStatus.alarmzaman = sessionStatus.zaman;
			//     sessionStatus.diffrencesayac = 0;
			//     sessionStatus.uyaridurum = 1;
			// }

			// Otomatik kontrol
			if (
				sessionStatus.otomanuel == 0 &&
				sessionStatus.cikis == 0 &&
				sessionStatus.wait == 0
			) {
				// O2/Hava kontrolü

				// PID kontrolü için ortalama fark hesapla
				var avgDifference =
					(sessionStatus.bufferdifference[sessionStatus.zaman] +
						sessionStatus.bufferdifference[sessionStatus.zaman - 1] +
						sessionStatus.bufferdifference[sessionStatus.zaman - 2]) /
					3;

				console.log('avgDiff', avgDifference.toFixed(2));

				// Kompresör kontrolü
				sessionStatus.pcontrol =
					sessionStatus.comp_offset +
					sessionStatus.comp_gain * difference +
					sessionStatus.fsw / sessionStatus.comp_depth;
				if (sessionStatus.pcontrol < sessionStatus.minimumvalve)
					sessionStatus.pcontrol = sessionStatus.minimumvalve;

				// Dekompresyon kontrolü
				var control =
					sessionStatus.decomp_offset -
					sessionStatus.decomp_gain * difference +
					sessionStatus.decomp_depth / sessionStatus.fsw;

				// Vana kontrolü
				if (sessionStatus.ventil == 0) {
					if (sessionStatus.grafikdurum == 1) {
						// Yükseliş
						if (difference > 0.1) {
							compValve(sessionStatus.pcontrol);
							decompValve(0);
						} else if (avgDifference < -0.6) {
							compValve(sessionStatus.minimumvalve);
							decompValve(0);
						} else if (avgDifference < -1.5) {
							compValve(0);
							decompValve(0);
						}
					} else if (sessionStatus.grafikdurum == 2) {
						// Düz
						if (avgDifference > 0.1) {
							compValve(sessionStatus.pcontrol);
							if (sessionStatus.ventil != 1) decompValve(0);
						} else if (avgDifference < -1) {
							compValve(0);
							decompValve(control);
						} else {
							compValve(0);
							decompValve(0);
						}
					} else {
						// İniş
						compValve(0);
						decompValve(Math.abs(control));
					}
				}
			}

			// Ventilasyon kontrolü
			if (
				(sessionStatus.ventil == 1 ||
					sessionStatus.ventil == 2 ||
					sessionStatus.ventil == 3) &&
				sessionStatus.otomanuel == 0
			) {
				if (difference < 0 && difference > -0.3) {
					sessionStatus.pcontrol = 5 * (sessionStatus.vanacikis / 9);
				} else if (difference < 0.5 && difference > 0) {
					sessionStatus.pcontrol = 2 * (sessionStatus.vanacikis / 3);
				} else if (difference > 0.5) {
					var avgDiff =
						(sessionStatus.bufferdifference[sessionStatus.zaman] +
							sessionStatus.bufferdifference[sessionStatus.zaman - 1] +
							sessionStatus.bufferdifference[sessionStatus.zaman - 2]) /
						3;
					sessionStatus.pcontrol =
						sessionStatus.comp_offset +
						sessionStatus.comp_gain * avgDiff +
						sessionStatus.fsw / sessionStatus.comp_depth;
					if (sessionStatus.pcontrol < 15) sessionStatus.pcontrol = 16;
				}
				compValve(sessionStatus.pcontrol);
				decompValve(sessionStatus.vanacikis);
			}

			// Çıkış durumu
			if (sessionStatus.cikis == 1) decompValve(90);

			// Yüksek oksijen kontrolü
			if (sessionStatus.higho == 1 && sessionStatus.ventil != 1) {
				sessionStatus.ventil = 1;
				sessionStatus.vanacikis = 30;
				if (sessionStatus.ohava == 1) ohavad('a');
				alarmSet('highO2', 'High O2 Level. Ventilation Started.', 0);
			}

			console.log(
				sessionStatus.zaman,
				sessionStatus.hedeflenen.length,
				sessionStatus.cikis,
				sessionStatus.eop,
				sessionStatus.main_fsw
			);
			// Seans sonu kontrolü
			if (
				(sessionStatus.zaman > sessionStatus.profile.length - 60 ||
					sessionStatus.cikis == 1) &&
				sessionStatus.eop == 0 &&
				sessionStatus.main_fsw <= 0.9
			) {
				alarmSet('endOfSession', 'Session Finished.', 0);
				sessionStartBit(0);
				doorOpen();
				sessionStatus.durum = 0;
				sessionStatus.uyariyenile = 1;
				sessionStatus.uyaridurum = 1;
				sessionStatus = {
					status: 0, // 0: session durumu yok, 1: session başlatıldı, 2: session duraklatıldı, 3: session durduruldu
					zaman: 0,
					dalisSuresi: 10,
					cikisSuresi: 10,
					hedeflenen: [],
					cikis: 0,
					grafikdurum: 0,
					adim: 0,
					adimzaman: [],
					maxadim: [],
					hedef: 0,
					lastdurum: 0,
					wait: 0,
					p2counter: 0,
					tempadim: 0,
					profile: [],
					minimumvalve: 12,
					otomanuel: 0,
					alarmzaman: 0,
					diffrencesayac: 0,
					higho: 0,
					highoc: 0,
					higho2: 0,
					pauseTime: 0,
					starttime: 0,
					pausetime: 0,
					ilksure: 0,
					ilkfsw: 0,
					fswd: 0,
					pauseDepteh: 0,
					doorSensorStatus: 0,
					doorStatus: 0,
					pressure: 0,
					o2: 0,
					bufferdifference: [],
					olcum: [],
					ventil: 0,
					main_fsw: 0,
					pcontrol: 0,
					comp_offset: 12,
					comp_gain: 8,
					comp_depth: 100,
					decomp_offset: 10,
					decomp_gain: 6,
					decomp_depth: 100,
					chamberStatus: 1,
					chamberStatusText: '',
					chamberStatusTime: null,
					setDerinlik: 0,
					dalisSuresi: 0,
					cikisSuresi: 0,
					toplamSure: 0,
					eop: 0,
					uyariyenile: 0,
					uyariyenile: 0,
					// Oksijen molası için eklenen değişkenler
					duzGrafikBaslangicZamani: 0,
					sonOksijenMolasi: 0,
					oksijenMolasiAktif: false,
				};
				global.sessionStatus = sessionStatus;
			}
		}

		// Görüntüleme değeri hesapla
		var displayValue = sessionStatus.main_fsw;
		if (
			Math.abs(difference) < 2.5 &&
			sessionStatus.profile[sessionStatus.zaman]
		) {
			displayValue = sessionStatus.profile[sessionStatus.zaman][1];
		}

		// Zaman görüntüleme
		var m_display = zeroPad(parseInt(sessionStatus.zaman / 60), 2);
		var s_display = zeroPad(sessionStatus.zaman % 60, 2);
		//document.getElementById('time').innerHTML = '<h3>' + m_display + ':' + s_display + '</h3>';
		//document.getElementById('carpan').innerHTML = sessionStatus.pcontrol + '-' + sessionStatus.manuelcompangel + '-' + sessionStatus.starttime + '-' + sessionStatus.pausetime;

		// Sensör verilerini kaydet

		// Gauge güncelle

		// Yüksek oksijen kontrolü

		//     if(sessionStatus.zaman % 5 == 0) {
		//         liveBit();
		//     }

		if (sessionStatus.mainov > sessionStatus.higho2) {
			sessionStatus.highoc++;
			if (sessionStatus.highoc > 5) {
				sessionStatus.higho = 1;
			}
		} else {
			sessionStatus.highoc = 0;
			if (sessionStatus.ventil != 0 && sessionStatus.higho == 1) {
				sessionStatus.higho = 0;
				sessionStatus.ventil = 0;
			}
		}
	}
}

function read_demo() {
	// Simulate sensor values based on profile
	console.log(
		sessionStatus.status,
		sessionStatus.zaman,
		sessionStatus.grafikdurum
	);

	// Update time display (simulated)
	const now = new Date();

	if (sessionStatus.status > 0) sessionStatus.zaman++;

	// if (sessionStatus.status == 1 && sessionStatus.doorStatus == 0) {
	//     console.log("door closing")
	//     alarmSet('sessionStarting', 'Session Starting', 0);
	//     //doorClose();
	// }

	// Sistem aktifse kontrol et
	if (sessionStatus.status > 0 && sessionStatus.zaman > 5) {
		// Simulate pressure based on profile (demo mode)zaxaza
		if (
			sessionStatus.profile.length > sessionStatus.zaman &&
			sessionStatus.profile[sessionStatus.zaman]
		) {
			sensorData['pressure'] = sessionStatus.profile[sessionStatus.zaman][1];
			sessionStatus.hedef =
				sessionStatus.profile[sessionStatus.zaman][1] * 33.4;
		} else if (
			sessionStatus.profile.length > 0 &&
			sessionStatus.profile[sessionStatus.profile.length - 1]
		) {
			sensorData['pressure'] =
				sessionStatus.profile[sessionStatus.profile.length - 1][1];
			sessionStatus.hedef =
				sessionStatus.profile[sessionStatus.profile.length - 1][1] * 33.4;
		} else {
			sensorData['pressure'] = 0;
			sessionStatus.hedef = 0;
		}

		// Simulate other sensor data
		sensorData['o2'] = 21.1;
		sensorData['temperature'] = 22.5 + (Math.random() * 2 - 1); // 21.5-23.5°C
		sensorData['humidity'] = 45 + (Math.random() * 10 - 5); // 40-50%

		// Update session status with simulated data
		sensorData['pressure'] = sessionStatus.hedef / 33.4;
		sessionStatus.pressure = sessionStatus.hedef / 33.4;
		sessionStatus.main_fsw = sessionStatus.hedef / 33.4;
		sessionStatus.o2 = sensorData['o2'];

		// Çıkış durumunda hedefi sıfırla
		if (
			sessionStatus.zaman > sessionStatus.profile.length ||
			sessionStatus.cikis == 1
		) {
			sessionStatus.hedef = 0;
		}

		console.log('hedef (demo): ', sessionStatus.hedef.toFixed(2));

		// Grafik durumunu belirle (yükseliş/iniş/düz)
		sessionStatus.lastdurum = sessionStatus.grafikdurum;

		// Check if current and next profile points exist
		if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.profile[sessionStatus.zaman + 1]
		) {
			if (
				sessionStatus.profile[sessionStatus.zaman][1] >
				sessionStatus.profile[sessionStatus.zaman + 1][1]
			) {
				sessionStatus.grafikdurum = 0; // İniş
			} else if (
				sessionStatus.profile[sessionStatus.zaman][1] <
				sessionStatus.profile[sessionStatus.zaman + 1][1]
			) {
				sessionStatus.grafikdurum = 1; // Çıkış
			} else {
				sessionStatus.grafikdurum = 2; // Düz
			}
		} else {
			sessionStatus.grafikdurum = 0; // Default to descent when at end
		}

		// Oksijen molası kontrolü - Düz grafik durumunda (demo mode)
		if (sessionStatus.grafikdurum === 2) {
			// Düz grafik durumunun başlangıcını kaydet
			if (sessionStatus.lastdurum !== 2 && sessionStatus.cikis == 0) {
				sessionStatus.duzGrafikBaslangicZamani = sessionStatus.zaman;
				sessionStatus.sonOksijenMolasi = sessionStatus.zaman;
				console.log(
					'Demo: Düz grafik durumu başladı, oksijen molası timer başlatıldı:',
					sessionStatus.zaman
				);
				alarmSet('oxygenBreak', 'Please wear your mask. ', 900);
			}

			// Her 15 dakikada (900 saniye) bir oksijen molası uyarısı
			const dakika15Saniye = 15 * 60; // 900 saniye
			const dakika5Saniye = 5 * 60; // 300 saniye
			const gecenSure = sessionStatus.zaman - sessionStatus.sonOksijenMolasi;

			// 15 dakika geçtiyse ve henüz uyarı aktif değilse
			if (
				gecenSure >= dakika15Saniye &&
				!sessionStatus.oksijenMolasiAktif &&
				sessionStatus.cikis == 0
			) {
				alarmSet(
					'oxygenBreak',
					'Please take off your mask. Oxygen Break.',
					dakika5Saniye
				);
				sessionStatus.oksijenMolasiAktif = true;
				sessionStatus.sonOksijenMolasi = sessionStatus.zaman;
				console.log(
					'Demo: Oksijen molası uyarısı verildi:',
					sessionStatus.zaman
				);
			}

			// 5 dakika sonra uyarıyı kapatx
			if (
				sessionStatus.oksijenMolasiAktif &&
				sessionStatus.zaman - sessionStatus.sonOksijenMolasi >= dakika5Saniye &&
				sessionStatus.cikis == 0
			) {
				sessionStatus.oksijenMolasiAktif = false;
				console.log(
					'Demo: Oksijen molası uyarısı sona erdi:',
					sessionStatus.zaman
				);
				alarmSet('oxygenBreak', 'Please wear your mask.', 0);
			}
		} else {
			// Düz durumdan çıkıldığında timer'ları sıfırla
			if (sessionStatus.lastdurum === 2 && sessionStatus.cikis == 0) {
				sessionStatus.duzGrafikBaslangicZamani = 0;
				sessionStatus.oksijenMolasiAktif = false;
				console.log(
					'Demo: Düz grafik durumu sona erdi, oksijen molası timer sıfırlandı:',
					sessionStatus.zaman
				);
				alarmSet('oxygenBreak', 'Please take off your mask.', 0);
			}
		}

		// Check if step (adım) has changed
		if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.adim !== sessionStatus.profile[sessionStatus.zaman][2]
		) {
			console.log(
				'Step changed from',
				sessionStatus.adim,
				'to',
				sessionStatus.profile[sessionStatus.zaman][2]
			);
			//alarmSet('stepChange', 'Step Changed', 0);
		}

		// Adım kontrolü
		if (
			sessionStatus.grafikdurum != sessionStatus.lastdurum &&
			sessionStatus.wait == 0
		) {
			sessionStatus.p2counter = 0;
		}

		if (sessionStatus.profile[sessionStatus.zaman]) {
			sessionStatus.adim = sessionStatus.profile[sessionStatus.zaman][2];
		}

		// Zaman hesaplamaları
		var s = sessionStatus.zaman % 60;
		var m = parseInt(sessionStatus.zaman / 60);

		sessionStatus.p2counter++;

		// Global değişkenleri güncelle
		sessionStatus.fsw = sessionStatus.main_fsw;
		sessionStatus.fswd = sessionStatus.main_fswd;

		// Fark hesaplama
		var difference =
			parseFloat(sessionStatus.hedef) - parseFloat(sessionStatus.main_fsw);
		sessionStatus.bufferdifference[sessionStatus.zaman] = difference;
		sessionStatus.olcum.push(sessionStatus.main_fsw);

		console.log('difference (demo):', difference);
		console.log(
			'pressure (demo):',
			sessionStatus.pressure,
			sessionStatus.fsw.toFixed(2)
		);

		// İlk basınç kaydı
		if (sessionStatus.zaman == 1) {
			sessionStatus.ilkbasinc = sessionStatus.fsw;
		}

		// Uyarı kontrolü
		if (sessionStatus.zaman > 0) {
			// Sapma uyarısı
			if (Math.abs(sessionStatus.bufferdifference[sessionStatus.zaman]) > 5) {
				sessionStatus.diffrencesayac++;
			}

			// Otomatik kontrol (simulated)
			if (
				sessionStatus.otomanuel == 0 &&
				sessionStatus.cikis == 0 &&
				sessionStatus.wait == 0
			) {
				// PID kontrolü için ortalama fark hesapla
				var avgDifference =
					(sessionStatus.bufferdifference[sessionStatus.zaman] +
						sessionStatus.bufferdifference[sessionStatus.zaman - 1] +
						sessionStatus.bufferdifference[sessionStatus.zaman - 2]) /
					3;

				console.log('avgDiff (demo)', avgDifference.toFixed(2));

				// Kompresör kontrolü (simulated)
				sessionStatus.pcontrol =
					sessionStatus.comp_offset +
					sessionStatus.comp_gain * difference +
					sessionStatus.fsw / sessionStatus.comp_depth;
				if (sessionStatus.pcontrol < sessionStatus.minimumvalve)
					sessionStatus.pcontrol = sessionStatus.minimumvalve;

				// Dekompresyon kontrolü (simulated)
				var control =
					sessionStatus.decomp_offset -
					sessionStatus.decomp_gain * difference +
					sessionStatus.decomp_depth / sessionStatus.fsw;

				// Vana kontrolü (simulated - no actual hardware commands)
				if (sessionStatus.ventil == 0) {
					if (sessionStatus.grafikdurum == 1) {
						// Yükseliş
						if (difference > 0.1) {
							console.log(
								'Demo: Would open comp valve to',
								sessionStatus.pcontrol
							);
							// compValve(sessionStatus.pcontrol); - disabled for demo
						} else if (avgDifference < -0.6) {
							console.log('Demo: Would set comp valve to minimum');
							// compValve(sessionStatus.minimumvalve); - disabled for demo
						} else if (avgDifference < -1.5) {
							console.log('Demo: Would close comp valve');
							// compValve(0); - disabled for demo
						}
					} else if (sessionStatus.grafikdurum == 2) {
						// Düz
						if (difference > 0.1) {
							console.log(
								'Demo: Would open comp valve to',
								sessionStatus.pcontrol
							);
						} else if (difference < -1) {
							console.log(
								'Demo: Would open decomp valve to',
								Math.abs(control)
							);
						} else {
							console.log('Demo: Would close both valves');
						}
					} else {
						// İniş
						console.log('Demo: Would open decomp valve to', Math.abs(control));
					}
				}
			}

			// Ventilasyon kontrolü (simulated)
			if (
				(sessionStatus.ventil == 1 ||
					sessionStatus.ventil == 2 ||
					sessionStatus.ventil == 3) &&
				sessionStatus.otomanuel == 0
			) {
				if (difference < 0 && difference > -0.3) {
					sessionStatus.pcontrol = 5 * (sessionStatus.vanacikis / 9);
				} else if (difference < 0.5 && difference > 0) {
					sessionStatus.pcontrol = 2 * (sessionStatus.vanacikis / 3);
				} else if (difference > 0.5) {
					var avgDiff =
						(sessionStatus.bufferdifference[sessionStatus.zaman] +
							sessionStatus.bufferdifference[sessionStatus.zaman - 1] +
							sessionStatus.bufferdifference[sessionStatus.zaman - 2]) /
						3;
					sessionStatus.pcontrol =
						sessionStatus.comp_offset +
						sessionStatus.comp_gain * avgDiff +
						sessionStatus.fsw / sessionStatus.comp_depth;
					if (sessionStatus.pcontrol < 15) sessionStatus.pcontrol = 16;
				}
				console.log(
					'Demo: Ventilation mode - comp valve:',
					sessionStatus.pcontrol,
					'decomp valve:',
					sessionStatus.vanacikis
				);
			}

			// Çıkış durumu
			if (sessionStatus.cikis == 1) {
				console.log('Demo: Would open decomp valve to 90');
			}

			// Yüksek oksijen kontrolü (simulated)
			if (sessionStatus.higho == 1 && sessionStatus.ventil != 1) {
				sessionStatus.ventil = 1;
				sessionStatus.vanacikis = 30;
				alarmSet('highO2', 'High O2 Level. Ventilation Started.', 0);
			}

			console.log(
				sessionStatus.zaman,
				sessionStatus.profile.length,
				sessionStatus.cikis,
				sessionStatus.eop,
				sessionStatus.main_fsw
			);

			// Seans sonu kontrolü
			if (
				(sessionStatus.zaman > sessionStatus.profile.length - 60 ||
					sessionStatus.cikis == 1) &&
				sessionStatus.eop == 0 &&
				sessionStatus.main_fsw <= 0.5
			) {
				alarmSet('endOfSession', 'Session Finished.', 0);
				sessionStartBit(0);
				//doorOpen();
				sessionStatus.status = 0;
				sessionStatus.uyariyenile = 1;
				sessionStatus.uyaridurum = 1;

				// Reset session status
				sessionStatus = {
					status: 0,
					zaman: 0,
					dalisSuresi: 10,
					cikisSuresi: 10,
					hedeflenen: [],
					cikis: 0,
					grafikdurum: 0,
					adim: 0,
					adimzaman: [],
					maxadim: [],
					hedef: 0,
					lastdurum: 0,
					wait: 0,
					p2counter: 0,
					tempadim: 0,
					profile: [],
					minimumvalve: 12,
					otomanuel: 0,
					alarmzaman: 0,
					diffrencesayac: 0,
					higho: 0,
					highoc: 0,
					higho2: 0,
					pauseTime: 0,
					starttime: 0,
					pausetime: 0,
					ilksure: 0,
					ilkfsw: 0,
					fswd: 0,
					pauseDepteh: 0,
					doorSensorStatus: 0,
					doorStatus: 0,
					pressure: 0,
					o2: 0,
					bufferdifference: [],
					olcum: [],
					ventil: 0,
					main_fsw: 0,
					pcontrol: 0,
					comp_offset: 12,
					comp_gain: 8,
					comp_depth: 100,
					decomp_offset: 10,
					decomp_gain: 6,
					decomp_depth: 100,
					chamberStatus: 1,
					chamberStatusText: '',
					chamberStatusTime: null,
					setDerinlik: 0,
					dalisSuresi: 0,
					cikisSuresi: 0,
					toplamSure: 0,
					eop: 0,
					uyariyenile: 0,
					// Oksijen molası için eklenen değişkenler
					duzGrafikBaslangicZamani: 0,
					sonOksijenMolasi: 0,
					oksijenMolasiAktif: false,
				};
				global.sessionStatus = sessionStatus;
			}
		}

		// Görüntüleme değeri hesapla
		var displayValue = sessionStatus.main_fsw;
		if (
			Math.abs(difference) < 2.5 &&
			sessionStatus.profile[sessionStatus.zaman]
		) {
			displayValue = sessionStatus.profile[sessionStatus.zaman][1];
		}

		// Zaman görüntüleme
		var m_display = zeroPad(parseInt(sessionStatus.zaman / 60), 2);
		var s_display = zeroPad(sessionStatus.zaman % 60, 2);

		console.log('Demo time:', m_display + ':' + s_display);

		// Yüksek oksijen kontrolü (simulated)
		if (sessionStatus.mainov > sessionStatus.higho2) {
			sessionStatus.highoc++;
			if (sessionStatus.highoc > 5) {
				sessionStatus.higho = 1;
			}
		} else {
			sessionStatus.highoc = 0;
			if (sessionStatus.ventil != 0 && sessionStatus.higho == 1) {
				sessionStatus.higho = 0;
				sessionStatus.ventil = 0;
			}
		}
	}
}

function linearInterpolation(startValue, endValue, duration) {
	const result = [];

	// Her saniye için değer hesapla
	for (let t = 0; t <= duration * 60; t++) {
		// Doğrusal interpolasyon formülü: start + (end - start) * (t / duration)
		const progress = t / (duration * 60);
		const value = startValue + (endValue - startValue) * progress;

		result.push({
			time: t,
			value: Math.round(value * 1000) / 1000, // 3 ondalık basamağa yuvarla
		});
	}

	return result;
}

function profileGenerate(dalisSuresi, cikisSuresi, toplamSure, derinlik) {
	const result = [];
	const dalis = linearInterpolation(0, derinlik, dalisSuresi);
	const cikis = linearInterpolation(derinlik, 0, cikisSuresi);
	const tedaviSuresi = dalisSuresi + cikisSuresi;
	for (let i = 0; i < tedaviSuresi; i++) {
		result.push(dalis[i].value);
	}
	return result;
}

function alarmSet(type, text, duration) {
	alarmStatus.status = 1;
	alarmStatus.type = type;
	alarmStatus.text = text;
	alarmStatus.time = dayjs();
	alarmStatus.duration = duration;

	socket.emit('chamberControl', {
		type: 'alarm',
		data: {
			...alarmStatus,
		},
	});
}

function alarmClear() {
	alarmStatus.status = 0;
	alarmStatus.type = '';
	alarmStatus.text = '';
	alarmStatus.time = 0;
	alarmStatus.duration = 0;
}

function doorClose() {
	if (sessionStatus.doorSensorStatus == 0) {
		alarmSet('doorIsOpen', 'Please check the door is closed properly.', 10);
		sessionStatus.doorStatus = 0;
	} else {
		socket.emit('writeBit', { register: 'M0100', value: 1 });
		sessionStatus.doorStatus = 1;
	}
}

function doorOpen() {
	console.log('door Opening');
	socket.emit('writeBit', { register: 'M0100', value: 0 });
	sessionStatus.doorStatus = 0;
}

function liveBit() {
	socket.emit('writeBit', { register: 'M0121', value: 1 });
}

function sessionStartBit(value) {
	socket.emit('writeBit', { register: 'M0120', value: value });
}

function zeroPad(num, numZeros) {
	var n = Math.abs(num);
	var zeros = Math.max(0, numZeros - Math.floor(n).toString().length);
	var zeroString = Math.pow(10, zeros).toString().substr(1);
	if (num < 0) {
		zeroString = '-' + zeroString;
	}

	return zeroString + n;
}

function compValve(angle) {
	if (angle > 90) angle = 90;
	if (angle < 0) angle = 0;
	angle = Math.round(angle);
	console.log('compValve', angle);

	// var send = angle * 364.08; //(32767/90derece)
	// send = send.toFixed(0);
	// Plc.writeUint({
	// 	addr: '%QB34',
	// 	strlen: 2,
	// 	val: send,
	// });

	var send = linearConversion(2500, 16383, 0, 90, angle, 0); //(32767/90derece)

	socket.emit(
		'writeRegister',
		JSON.stringify({ register: 'R01000', value: send })
	);
}

function drainOn() {
	socket.emit('writeBit', { register: 'M0120', value: 1 });
}

function drainOff() {
	socket.emit('writeBit', { register: 'M0120', value: 0 });
}

function decompValve(angle) {
	angle = Math.round(angle);
	console.log('decompvalve ', angle);

	if (angle > 90) angle = 90;
	if (angle < 0) angle = 0;

	// var send = angle * 364.08; //(32767/90derece)
	// send = send.toFixed(0);
	// Plc.writeUint({
	// 	addr: '%QB38',
	// 	strlen: 2,
	// 	val: send,
	// });

	var send = linearConversion(2500, 16383, 0, 90, angle, 0); //(32767/90derece)

	socket.emit(
		'writeRegister',
		JSON.stringify({ register: 'R01001', value: send })
	);
}

function sessionResume(
	pauseStartTime,
	pauseEndTime,
	currentPressure,
	initialPressure,
	stepDuration
) {
	// Calculate elapsed pause time
	const pauseDuration = pauseEndTime - pauseStartTime;

	// Get current step in profile
	const currentStep = sessionStatus.profile[pauseStartTime];
	const nextStep = sessionStatus.profile[pauseStartTime + 1];

	if (!currentStep || !nextStep) {
		console.log('Invalid step data for resume');
		return;
	}

	const currentDepth = currentStep[1];
	const nextDepth = nextStep[1];
	const depthDifference = nextDepth - currentDepth;

	// Handle ascending profile (depth increasing)
	if (depthDifference > 0) {
		const originalDuration = currentStep[0];
		const originalTargetDepth = currentStep[1];

		// Calculate slope from previous step
		let slope = 0;
		if (pauseStartTime > 0) {
			const prevStep = sessionStatus.profile[pauseStartTime - 1];
			slope = (originalTargetDepth - prevStep[1]) / originalDuration;
		}

		// Calculate time needed to reach target from current position
		const remainingDepthChange = originalTargetDepth - currentPressure;
		const timeToTarget = remainingDepthChange / slope;

		// Update current step duration
		sessionStatus.profile[pauseStartTime] = [
			Number((stepDuration / 60).toFixed(4)),
			initialPressure,
			currentStep[2],
		];

		// Insert pause segment
		sessionStatus.profile.splice(pauseStartTime + 1, 0, [
			Number((pauseDuration / 60).toFixed(4)),
			currentPressure,
			'air',
		]);

		// Insert recovery segment to reach original target
		sessionStatus.profile.splice(pauseStartTime + 2, 0, [
			Number(timeToTarget.toFixed(4)),
			originalTargetDepth,
			'air',
		]);
	}
	// Handle flat profile (same depth)
	else if (depthDifference === 0) {
		const originalDuration = currentStep[0];
		const originalTargetDepth = currentStep[1];

		// Calculate slope from first step
		let slope = 0;
		if (sessionStatus.profile[0]) {
			slope = sessionStatus.profile[0][1] / sessionStatus.profile[0][0];
		}

		const timeToTarget = (originalTargetDepth - currentPressure) / slope;

		// Update current step
		sessionStatus.profile[pauseStartTime] = [
			Number((stepDuration / 60).toFixed(4)),
			initialPressure,
			currentStep[2],
		];

		// Insert pause segment
		sessionStatus.profile.splice(pauseStartTime + 1, 0, [
			Number((pauseDuration / 60).toFixed(4)),
			currentPressure,
			'air',
		]);

		// Insert recovery segment
		sessionStatus.profile.splice(pauseStartTime + 2, 0, [
			Number(Math.abs(timeToTarget).toFixed(4)),
			originalTargetDepth,
			'air',
		]);

		// Insert remaining flat segment
		const remainingFlatTime = originalDuration - stepDuration / 60;
		sessionStatus.profile.splice(pauseStartTime + 3, 0, [
			Number(Math.abs(remainingFlatTime).toFixed(4)),
			originalTargetDepth,
			currentStep[2],
		]);
	}
	// Handle descending profile (depth decreasing)
	else if (depthDifference < 0) {
		const originalDuration = currentStep[0];
		const originalTargetDepth = currentStep[1];

		// Calculate slope from last decompression step
		let slope = 0;
		const profileLength = sessionStatus.profile.length;
		if (profileLength >= 2) {
			const lastStep = sessionStatus.profile[profileLength - 2];
			const finalStep = sessionStatus.profile[profileLength - 1];
			slope = lastStep[1] / finalStep[0];
		}

		const depthChangeNeeded = currentPressure - originalTargetDepth;
		const timeToTarget = depthChangeNeeded / slope;

		// Update current step
		sessionStatus.profile[pauseStartTime] = [
			Number((stepDuration / 60).toFixed(4)),
			initialPressure,
			currentStep[2],
		];

		// Insert pause segment
		sessionStatus.profile.splice(pauseStartTime + 1, 0, [
			Number((pauseDuration / 60).toFixed(4)),
			currentPressure,
			'air',
		]);

		// Insert recovery segment
		sessionStatus.profile.splice(pauseStartTime + 2, 0, [
			Number(Math.abs(timeToTarget).toFixed(4)),
			originalTargetDepth,
			currentStep[2],
		]);
	}

	// Reset control variables
	sessionStatus.p2counter = 0;
	sessionStatus.adim = 0;

	console.log('Profile updated for session resume:', sessionStatus.profile);
}

function sessionStop() {
	console.log('Session stop initiated at time:', sessionStatus.zaman);

	// Set exit mode (equivalent to cikis=3 in PHP)
	sessionStatus.cikis = 3;
	sessionStatus.status = 3;
	sessionStatus.otomanuel = 0;

	// Convert profile to hedeflenen array format (depth values only)
	let hedeflenen = [];
	for (let i = 0; i < sessionStatus.profile.length; i++) {
		hedeflenen[i] = sessionStatus.profile[i][1];
	}

	const currentTime = sessionStatus.zaman; // baslangic in PHP
	const arraylength = hedeflenen.length;

	// Find the last point where profile was ascending or flat
	// (equivalent to finding where $status > 0 || $status == 0 in PHP)
	let breakTime = currentTime;
	for (let i = arraylength - 1; i > 1; i--) {
		const status = hedeflenen[i] - hedeflenen[i - 1];
		if (status > 0 || status == 0) {
			breakTime = i + 1;
			break;
		}
	}

	console.log('Break time found at:', breakTime);

	// Calculate slope (egim in PHP)
	const egim =
		(sessionStatus.setDerinlik * 33.4) / (sessionStatus.cikisSuresi * 60);

	// Calculate time span (s in PHP)
	const s = arraylength - breakTime;

	// Calculate required decompression time (gerekensure in PHP)
	const currentPressure = hedeflenen[currentTime - 1] || sessionStatus.main_fsw;
	const gerekensure = Math.round(currentPressure / (egim / s));

	console.log('Calculated decompression parameters:', {
		egim: egim,
		timeSpan: s,
		currentPressure: currentPressure,
		requiredTime: gerekensure,
	});

	// Create new decompression profile
	let m = currentPressure;
	const slopePerSecond = egim / s;

	// Clear the profile from current time onwards
	sessionStatus.profile = sessionStatus.profile.slice(0, currentTime);

	// Generate smooth decompression to surface
	for (let i = currentTime; i <= currentTime + gerekensure; i++) {
		m = m - slopePerSecond;
		if (m < 0) m = 0;

		// Add to profile in [duration, depth, gas] format
		sessionStatus.profile[i] = [
			Number((1 / 60).toFixed(4)), // 1 second duration converted to minutes
			Number(m.toFixed(2)),
			'air',
		];
	}

	// Ensure final point is exactly 0
	if (sessionStatus.profile.length > 0) {
		const lastIndex = sessionStatus.profile.length - 1;
		sessionStatus.profile[lastIndex][1] = 0;
	}

	console.log(
		'Updated profile for emergency stop:',
		sessionStatus.profile.slice(currentTime - 5, currentTime + 10)
	);

	// Set exit flag for valve control
	sessionStatus.cikis = 1;

	alarmSet(
		'sessionStop',
		'Emergency session stop initiated. Decompressing to surface.',
		0
	);
}

/**
 * Seans sırasında sadece tedavi derinliğini (orta faz) değiştiren fonksiyon
 * Giriş ve çıkış hızlarını/değerlerini değiştirmez
 * @param {number} newDepth - Yeni tedavi derinliği (bar)
 */
function updateTreatmentDepth(newDepth) {
	if (!sessionStatus.profile || sessionStatus.profile.length === 0) {
		console.log('Profil bulunamadı.');
		return false;
	}
	// Saniye bazlı profil mi yoksa adım bazlı mı kontrol et
	// Saniye bazlı: [zaman, basınç, tip, adım]
	// Adım bazlı: [dakika, basınç, tip]
	sessionStatus.setDerinlik = newDepth;
	if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 4
	) {
		// Saniye bazlı profil: adım numarası 2 olanları güncelle
		sessionStatus.profile = sessionStatus.profile.map((step) => {
			if (step[3] === 2) {
				return [step[0], newDepth, step[2], step[3]];
			}
			return step;
		});
	} else if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 3
	) {
		// Adım bazlı profil: sadece ortadaki adım(lar)ı güncelle
		if (sessionStatus.profile.length >= 3) {
			// Sadece 2. adım (index 1) güncellenir
			sessionStatus.profile[1][1] = newDepth;
		} else if (sessionStatus.profile.length === 1) {
			// Tek adım varsa, onu güncelle
			sessionStatus.profile[0][1] = newDepth;
		}
	} else {
		console.log('Profil formatı tanınamadı.');
		return false;
	}
	// Gerekirse güncellenmiş profili frontend'e bildir

	console.log(`Tedavi derinliği ${newDepth} bar olarak güncellendi.`);
	return true;
}

/**
 * Toplam süre değiştiğinde dalış ve çıkış süresi ile derinlik sabit kalacak şekilde profili günceller
 * Sadece tedavi süresi (orta faz) yeni toplam süreye göre ayarlanır
 * @param {number} newTotalDuration - Yeni toplam süre (dakika)
 */
function updateTotalSessionDuration(newTotalDuration) {
	if (!sessionStatus.profile || sessionStatus.profile.length === 0) {
		console.log('Profil bulunamadı.');
		return false;
	}
	const dalisSuresi = sessionStatus.dalisSuresi;
	const cikisSuresi = sessionStatus.cikisSuresi;
	const derinlik = sessionStatus.setDerinlik;
	const newTreatmentDuration = newTotalDuration - (dalisSuresi + cikisSuresi);
	if (newTreatmentDuration <= 0) {
		console.log(
			'Yeni toplam süre, dalış ve çıkış sürelerinin toplamından büyük olmalı.'
		);
		return false;
	}
	// Adım bazlı profil: [dakika, basınç, tip]
	if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 3
	) {
		if (sessionStatus.profile.length >= 3) {
			// Sadece 2. adımın süresi güncellenir
			sessionStatus.profile[1][0] = newTreatmentDuration;
		} else if (sessionStatus.profile.length === 1) {
			// Tek adım varsa, onu güncelle
			sessionStatus.profile[0][0] = newTotalDuration;
		}
	}
	// Saniye bazlı profil: [zaman, basınç, tip, adım]
	else if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 4
	) {
		// Giriş ve çıkış sürelerini saniyeye çevir
		const dalisSaniye = Math.round(dalisSuresi * 60);
		const cikisSaniye = Math.round(cikisSuresi * 60);
		const tedaviSaniye = Math.round(newTreatmentDuration * 60);
		// Yeni profil dizisi oluştur
		const newProfile = [];
		let adim = 1;
		// Giriş fazı (adım 1)
		for (let i = 0; i < dalisSaniye; i++) {
			const step = sessionStatus.profile[i];
			if (step && step[3] === 1) newProfile.push([...step]);
		}
		adim = 2;
		// Tedavi fazı (adım 2)
		const tedaviStep = sessionStatus.profile.find((step) => step[3] === 2);
		for (let i = 0; i < tedaviSaniye; i++) {
			if (tedaviStep) {
				newProfile.push([
					newProfile.length + 1,
					tedaviStep[1],
					tedaviStep[2],
					2,
				]);
			}
		}
		adim = 3;
		// Çıkış fazı (adım 3)
		for (
			let i = sessionStatus.profile.length - cikisSaniye;
			i < sessionStatus.profile.length;
			i++
		) {
			const step = sessionStatus.profile[i];
			if (step && step[3] === 3) newProfile.push([...step]);
		}
		sessionStatus.profile = newProfile;
	} else {
		console.log('Profil formatı tanınamadı.');
		return false;
	}
	console.log(
		`Toplam süre ${newTotalDuration} dakika olarak güncellendi. Tedavi süresi: ${newTreatmentDuration} dakika.`
	);
	return true;
}

/**
 * Dalış ve çıkış süresi değiştiğinde profili günceller
 * Toplam süre ve derinlik sabit kalır, tedavi süresi otomatik ayarlanır
 * @param {number} newDiveDuration - Yeni dalış süresi (dakika)
 * @param {number} newExitDuration - Yeni çıkış süresi (dakika)
 */
function updateDiveAndExitDurations(newDiveDuration, newExitDuration) {
	if (!sessionStatus.profile || sessionStatus.profile.length === 0) {
		console.log('Profil bulunamadı.');
		return false;
	}
	const toplamSure = sessionStatus.dalisSuresi + sessionStatus.cikisSuresi;
	const currentTotal =
		sessionStatus.dalisSuresi +
		sessionStatus.cikisSuresi +
		(sessionStatus.profile[1] ? sessionStatus.profile[1][0] : 0);
	const derinlik = sessionStatus.setDerinlik;
	const totalDuration = sessionStatus.toplamSure || currentTotal;
	const newTreatmentDuration =
		totalDuration - (newDiveDuration + newExitDuration);
	if (newTreatmentDuration <= 0) {
		console.log(
			'Yeni dalış ve çıkış sürelerinin toplamı, toplam süreden küçük olmalı.'
		);
		return false;
	}
	// Adım bazlı profil: [dakika, basınç, tip]
	if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 3
	) {
		if (sessionStatus.profile.length >= 3) {
			// 1. adım: dalış süresi
			sessionStatus.profile[0][0] = newDiveDuration;
			// 2. adım: tedavi süresi
			sessionStatus.profile[1][0] = newTreatmentDuration;
			// 3. adım: çıkış süresi
			sessionStatus.profile[2][0] = newExitDuration;
		} else if (sessionStatus.profile.length === 1) {
			// Tek adım varsa, onu güncelle
			sessionStatus.profile[0][0] = totalDuration;
		}
	}
	// Saniye bazlı profil: [zaman, basınç, tip, adım]
	else if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 4
	) {
		const dalisSaniye = Math.round(newDiveDuration * 60);
		const cikisSaniye = Math.round(newExitDuration * 60);
		const tedaviSaniye = Math.round(newTreatmentDuration * 60);
		const newProfile = [];
		// Giriş fazı (adım 1)
		const girisStep = sessionStatus.profile.find((step) => step[3] === 1);
		for (let i = 0; i < dalisSaniye; i++) {
			if (girisStep) {
				newProfile.push([newProfile.length + 1, girisStep[1], girisStep[2], 1]);
			}
		}
		// Tedavi fazı (adım 2)
		const tedaviStep = sessionStatus.profile.find((step) => step[3] === 2);
		for (let i = 0; i < tedaviSaniye; i++) {
			if (tedaviStep) {
				newProfile.push([
					newProfile.length + 1,
					tedaviStep[1],
					tedaviStep[2],
					2,
				]);
			}
		}
		// Çıkış fazı (adım 3)
		const cikisStep = sessionStatus.profile.find((step) => step[3] === 3);
		for (let i = 0; i < cikisSaniye; i++) {
			if (cikisStep) {
				newProfile.push([newProfile.length + 1, cikisStep[1], cikisStep[2], 3]);
			}
		}
		sessionStatus.profile = newProfile;
	} else {
		console.log('Profil formatı tanınamadı.');
		return false;
	}
	// State güncelle
	sessionStatus.dalisSuresi = newDiveDuration;
	sessionStatus.cikisSuresi = newExitDuration;
	console.log(
		`Dalış süresi ${newDiveDuration} dakika, çıkış süresi ${newExitDuration} dakika olarak güncellendi. Tedavi süresi: ${newTreatmentDuration} dakika.`
	);
	return true;
}

sessionStatus.dalisSuresi = 10;
sessionStatus.cikisSuresi = 10;
sessionStatus.toplamSure = 60;
sessionStatus.setDerinlik = 1;

console.log(sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air');

// Calculate treatment duration for default profile
const defaultTreatmentDuration =
	sessionStatus.toplamSure -
	(sessionStatus.dalisSuresi + sessionStatus.cikisSuresi);

// Create alternating oxygen/air treatment segments for default profile
const defaultTreatmentSegments = createAlternatingTreatmentProfile(
	defaultTreatmentDuration,
	sessionStatus.setDerinlik
);

// Build complete default profile with descent, alternating treatment, and ascent
const defaultSetProfile = [
	[sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air'], // Descent phase
	...defaultTreatmentSegments, // Alternating oxygen/air treatment phases
	[sessionStatus.cikisSuresi, 0, 'air'], // Ascent phase
];

const quickProfile = ProfileUtils.createQuickProfile(defaultSetProfile);
sessionStatus.profile = quickProfile.toTimeBasedArrayBySeconds();

/**
 * Creates alternating oxygen and air break segments for treatment phase
 * @param {number} treatmentDuration - Total treatment duration in minutes
 * @param {number} depth - Treatment depth
 * @returns {Array} Array of profile segments [duration, depth, gas_type]
 */
function createAlternatingTreatmentProfile(treatmentDuration, depth) {
	const segments = [];
	const oxygenDuration = 15; // 15 minutes oxygen
	const airBreakDuration = 5; // 5 minutes air break
	const cycleDuration = oxygenDuration + airBreakDuration; // 20 minutes total per cycle

	let remainingTime = treatmentDuration;

	while (remainingTime > 0) {
		// Add oxygen segment
		if (remainingTime >= oxygenDuration) {
			segments.push([oxygenDuration, depth, 'o2']);
			remainingTime -= oxygenDuration;
		} else {
			// If less than 15 minutes remaining, use remaining time for oxygen
			segments.push([remainingTime, depth, 'o2']);
			remainingTime = 0;
			break;
		}

		// Add air break segment if there's still time
		if (remainingTime > 0) {
			if (remainingTime >= airBreakDuration) {
				segments.push([airBreakDuration, depth, 'air']);
				remainingTime -= airBreakDuration;
			} else {
				// If less than 5 minutes remaining, use remaining time for air break
				segments.push([remainingTime, depth, 'air']);
				remainingTime = 0;
			}
		}
	}

	return segments;
}
