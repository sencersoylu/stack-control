const net = require('net');
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const app = express();
const http = require('http');
const { io } = require('socket.io-client');
const cors = require('cors');
const { linearConversion } = require('./src/helpers');
const db = require('./src/models');
const { ProfileUtils, ProfileManager } = require('./profile_manager');
const dayjs = require('dayjs');
const SensorCalibration = require('./o2_calibration');

let server = http.Server(app);
const bodyParser = require('body-parser');

const connections = []; // view soket baÄlantÄ±larÄ±nÄ±n tutulduÄu array
let isWorking = 0;
let isConnectedPLC = 0;
let sensorCalibrationData = {}; // Object to store all sensor calibration data
let demoMode = 0;

db.sequelize.sync({});

init();
const allRoutes = require('./src/routes');

let sensorData = {};

let o2Timer = null;

// O2 Kalibrasyon verilerini saklamak iÃ§in obje
let o2CalibrationData = {
	point0: { raw: 0, percentage: 0 }, // %0 O2 iÃ§in analog deÄer
	point21: { raw: 960, percentage: 21 }, // %21 O2 iÃ§in analog deÄer (varsayÄ±lan)
	point100: { raw: 4600, percentage: 100 }, // %100 O2 iÃ§in analog deÄer
	isCalibrated: false,
	lastCalibrationDate: null,
	o2AlarmValuePercentage: 23.5,
	o2AlarmOn: false,
};

// O2 sensÃ¶r kalibrasyon instance'Ä±
let o2Sensor = null;

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
	status: 0, // 0: session durumu yok, 1: session baÅlatÄ±ldÄ±, 2: session duraklatÄ±ldÄ±, 3: session durduruldu
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
	minimumvalve: 5,
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
	comp_offset: 6,
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
	// Oksijen molasÄ± iÃ§in eklenen deÄiÅkenler
	duzGrafikBaslangicZamani: 0, // DÃ¼z grafik durumunun baÅladÄ±ÄÄ± zaman
	sonOksijenMolasi: 0, // Son oksijen molasÄ± verildiÄi zaman
	oksijenMolasiAktif: false, // Oksijen molasÄ± uyarÄ±sÄ±nÄ±n aktif olup olmadÄ±ÄÄ±
	sessionStartTime: dayjs(),
	patientAlarm: false,
	fireAlarm: false,
	alarm: false,
	// BasÄ±nÃ§ oranÄ± hesaplama iÃ§in
	pressRateFswPerMin: 0,
	pressRateBarPerMin: 0,
	// Deviation alarm iÃ§in
	deviationAlarm: false,
	// Profile bazlÄ± oksijen kontrolÃ¼ iÃ§in
	oksijenBaslangicZamani: 0,
	oksijenBitisZamani: 0,
	highHumidity: false,
	humidityAlarmLevel: 70,
	speed: 1,
};

// Make sessionStatus globally accessible
global.sessionStatus = sessionStatus;

// ------------------------------------------------------------
// Simple EMA low-pass filters for sensor smoothing
// ------------------------------------------------------------
class LowPassFilter {
	constructor(alpha, sensorName) {
		this.alpha = Number(alpha);
		this.sensorName = sensorName;
		this.y = undefined;
	}
	update(x) {
		const value = Number(x);
		if (!Number.isFinite(value)) {
			// Return current value rounded to sensorDecimal precision
			if (this.y === undefined) return 0;
			let outputDecimalPlaces = 2; // Default output precision
			if (
				sensorCalibrationData &&
				sensorCalibrationData[this.sensorName] &&
				typeof sensorCalibrationData[this.sensorName].sensorDecimal === 'number'
			) {
				outputDecimalPlaces =
					sensorCalibrationData[this.sensorName].sensorDecimal;
			}
			return Number(this.y.toFixed(outputDecimalPlaces));
		}

		// Get output decimal places from sensorCalibrationData
		let outputDecimalPlaces = 2; // Default output precision
		if (
			sensorCalibrationData &&
			sensorCalibrationData[this.sensorName] &&
			typeof sensorCalibrationData[this.sensorName].sensorDecimal === 'number'
		) {
			outputDecimalPlaces =
				sensorCalibrationData[this.sensorName].sensorDecimal;
		}

		if (this.y === undefined) {
			// First value: round to sensorDecimal precision
			this.y = Number(value.toFixed(outputDecimalPlaces));
		} else {
			// Preserve decimal precision using sensorDecimal from calibration data
			const newValue = this.alpha * value + (1 - this.alpha) * this.y;
			// Use high precision for internal calculations (sensorDecimal + 2)
			let internalDecimalPlaces = 4; // Default precision
			if (
				sensorCalibrationData &&
				sensorCalibrationData[this.sensorName] &&
				typeof sensorCalibrationData[this.sensorName].sensorDecimal === 'number'
			) {
				// Use sensorDecimal + 2 for internal precision (e.g., if sensorDecimal is 2, use 4)
				internalDecimalPlaces =
					sensorCalibrationData[this.sensorName].sensorDecimal + 2;
			}
			this.y = Number(newValue.toFixed(internalDecimalPlaces));
		}

		// Return value rounded to sensorDecimal precision
		return Number(this.y.toFixed(outputDecimalPlaces));
	}
}

const filterConfig = {
	pressure: Number(process.env.FILTER_ALPHA_PRESSURE || 0.35),
	o2: Number(process.env.FILTER_ALPHA_O2 || 0.2),
	temperature: Number(process.env.FILTER_ALPHA_TEMPERATURE || 0.25),
	humidity: Number(process.env.FILTER_ALPHA_HUMIDITY || 0.25),
};

const filters = {
	pressure: new LowPassFilter(filterConfig.pressure, 'pressure'),
	o2: new LowPassFilter(filterConfig.o2, 'o2'),
	temperature: new LowPassFilter(filterConfig.temperature, 'temperature'),
	humidity: new LowPassFilter(filterConfig.humidity, 'humidity'),
};

function computePressurizationRate(seconds = 60) {
	if (!Array.isArray(sessionStatus.olcum) || sessionStatus.olcum.length < 2)
		return 0;
	const totalSamples = sessionStatus.olcum.length;
	const windowSize = Math.min(seconds, totalSamples - 1);
	const startIndex = totalSamples - 1 - windowSize;
	const startValue = sessionStatus.olcum[startIndex];
	const endValue = sessionStatus.olcum[totalSamples - 1];
	const delta = endValue - startValue;
	if (windowSize <= 0) return 0;
	return (delta / windowSize) * 60; // fsw per minute
}

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
	initializeO2Sensor();

	setInterval(() => {
		liveBit();
	}, 3000);

	try {
		socket = io.connect('http://192.168.77.100:4000', { reconnect: true });
		socket.on('connect', function () {
			console.log('Connected to server');
			//doorOpen();
			compValve(0);
			decompValve(0);
			sessionStartBit(0);

			//socket.emit('writeRegister', JSON.stringify({address: "R03904", value: 8000}));
		});
		socket.on('disconnect', function () {
			console.log('Disconnected from server');
		});
		socket.on('data', async function (data) {
			//console.log('Received message:', data);
			const dataObject = JSON.parse(data);

			if (dataObject.data.length > 1) {
				let errorArray = Number(dataObject.data[10])
					.toString(2)
					.padStart(16, '0')
					.split('')
					.reverse();

				//Fire system alarm

				//console.log('errorArray', errorArray);

				if (errorArray[0] == '1' && sessionStatus.alarm == false) {
					socket.emit('writeBit', { register: 'M0400', value: 0 });
					sessionStatus.alarm = true;

					if (errorArray[2] == 1) {
						console.log('fireAlarm', errorArray[1]);
						alarmSet('fireAlarm', 'Smoke Detector Alarm', 10);
						buzzerOn();
					} else if (errorArray[1] == 1) {
						console.log('patientAlarm', errorArray[2]);
						alarmSet('patientAlarm', 'Patient Alarm', 10);
						buzzerOn();
					}
				} else if (errorArray[0] == '0') {
					sessionStatus.alarm = false;
				}

				sensorData['pressure'] = filters.pressure.update(
					linearConversion(
						sensorCalibrationData['pressure'].sensorLowerLimit,
						sensorCalibrationData['pressure'].sensorUpperLimit,
						sensorCalibrationData['pressure'].sensorAnalogLower,
						sensorCalibrationData['pressure'].sensorAnalogUpper,
						dataObject.data[1],
						sensorCalibrationData['pressure'].sensorDecimal
					)
				);
				sessionStatus.pressure = sensorData['pressure'];
				sessionStatus.main_fsw = sensorData['pressure'] * 33.4;

				// O2 sensÃ¶rÃ¼ iÃ§in gerÃ§ek analog deÄeri oku (dataObject.data[2] varsayÄ±yoruz)
				const o2RawValue = dataObject.data[2] || 8000; // EÄer veri yoksa varsayÄ±lan deÄer
				sensorData.o2RawValue = o2RawValue; // Ham deÄeri sakla
				let o2Value = o2Sensor ? o2Sensor.calibrate(o2RawValue) : 0;
				sensorData['o2'] = filters.o2.update(o2Value);

				sensorData['temperature'] = filters.temperature.update(
					linearConversion(
						sensorCalibrationData['temperature'].sensorLowerLimit,
						sensorCalibrationData['temperature'].sensorUpperLimit,
						sensorCalibrationData['temperature'].sensorAnalogLower,
						sensorCalibrationData['temperature'].sensorAnalogUpper,
						dataObject.data[4],
						sensorCalibrationData['temperature'].sensorDecimal
					)
				);

				sensorData['humidity'] = filters.humidity.update(
					linearConversion(
						sensorCalibrationData['humidity'].sensorLowerLimit,
						sensorCalibrationData['humidity'].sensorUpperLimit,
						sensorCalibrationData['humidity'].sensorAnalogLower,
						sensorCalibrationData['humidity'].sensorAnalogUpper,
						dataObject.data[5],
						sensorCalibrationData['humidity'].sensorDecimal
					)
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
				let dalisSuresi = 0;
				let cikisSuresi = 0;

				// Use speed from data to calculate dalisSuresi and cikisSuresi
				if (dt.data.speed == 1) {
					dalisSuresi = Math.round((dt.data.setDerinlik * 10) / 0.4);
					cikisSuresi = Math.round((dt.data.setDerinlik * 10) / 0.4);
				} else if (dt.data.speed == 2) {
					dalisSuresi = Math.round((dt.data.setDerinlik * 10) / 0.5);
					cikisSuresi = Math.round((dt.data.setDerinlik * 10) / 0.5);
				} else if (dt.data.speed == 3) {
					dalisSuresi = Math.round((dt.data.setDerinlik * 10) / 0.66666666);
					cikisSuresi = Math.round((dt.data.setDerinlik * 10) / 0.66666666);
				}
				sessionStatus.dalisSuresi = dalisSuresi;
				sessionStatus.cikisSuresi = cikisSuresi;
				sessionStatus.toplamSure = dt.data.toplamSure;
				sessionStatus.setDerinlik = dt.data.setDerinlik;
				sessionStatus.speed = dt.data.speed;
				console.log(
					'Seans Baslat : ',
					sessionStatus.dalisSuresi,
					'Cikis Sure : ',
					sessionStatus.cikisSuresi,
					'Toplam Sure : ',
					sessionStatus.toplamSure,
					'Derinlik : ',
					sessionStatus.setDerinlik
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

				console.log(setProfile);

				const quickProfile = ProfileUtils.createQuickProfile(setProfile);
				sessionStatus.profile = quickProfile.toTimeBasedArrayBySeconds();

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
				compValve(0);
				compValve(0);
				//doorOpen();

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
			} else if (dt.type == 'duration') {
				console.log('duration', dt.data.duration);
				sessionStatus.toplamSure = dt.data.duration;

				let dalisSuresi = 0;
				let cikisSuresi = 0;

				if (sessionStatus.speed == 1) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.4);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.4);
				} else if (sessionStatus.speed == 2) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
				} else if (sessionStatus.speed == 3) {
					dalisSuresi = Math.round(
						(sessionStatus.setDerinlik * 10) / 0.66666666
					);
					cikisSuresi = Math.round(
						(sessionStatus.setDerinlik * 10) / 0.66666666
					);
				}

				sessionStatus.dalisSuresi = dalisSuresi;
				sessionStatus.cikisSuresi = cikisSuresi;

				createChart();
			} else if (dt.type == 'pressure') {
				sessionStatus.setDerinlik = dt.data.pressure;

				let dalisSuresi = 0;
				let cikisSuresi = 0;

				if (sessionStatus.speed == 1) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.4);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.4);
				} else if (sessionStatus.speed == 2) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
				} else if (sessionStatus.speed == 3) {
					dalisSuresi = Math.round(
						(sessionStatus.setDerinlik * 10) / 0.66666666
					);
					cikisSuresi = Math.round(
						(sessionStatus.setDerinlik * 10) / 0.66666666
					);
				}

				sessionStatus.dalisSuresi = dalisSuresi;
				sessionStatus.cikisSuresi = cikisSuresi;

				createChart();
			} else if (dt.type == 'speed') {
				console.log('speed', dt.data.speed);
				sessionStatus.speed = dt.data.speed;

				let dalisSuresi = 0;
				let cikisSuresi = 0;

				if (dt.data.speed == 1) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.4);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
				} else if (dt.data.speed == 2) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
				} else if (dt.data.speed == 3) {
					dalisSuresi = Math.round(
						(sessionStatus.setDerinlik * 10) / 0.66666666
					);
					cikisSuresi = Math.round(
						(sessionStatus.setDerinlik * 10) / 0.66666666
					);
				}

				sessionStatus.dalisSuresi = dalisSuresi;
				sessionStatus.cikisSuresi = cikisSuresi;
				sessionStatus.speed = dt.data.speed;
				createChart();

				console.log(
					'Seans Baslat : ',
					sessionStatus.dalisSuresi,
					'Cikis Sure : ',
					sessionStatus.cikisSuresi,
					'Toplam Sure : ',
					sessionStatus.toplamSure,
					'Derinlik : ',
					sessionStatus.setDerinlik
				);
			} else if (dt.type == 'fan') {
				console.log('fan', dt.data.fan);
				if (dt.data.fan) {
					socket.emit('writeBit', { register: 'M0100', value: 1 });
				} else {
					socket.emit('writeBit', { register: 'M0100', value: 0 });
				}
			} else if (dt.type == 'light') {
				console.log('light', dt.data.light);
				if (dt.data.light) {
					socket.emit('writeBit', { register: 'M0101', value: 1 });
				} else {
					socket.emit('writeBit', { register: 'M0101', value: 0 });
				}
			}
		});

		socket.on('sessionStart', function (data) {
			console.log('sessionStart', data);
			const dt = JSON.parse(data);
			let dalisSuresi = 0;
			let cikisSuresi = 0;
			// Use speed from data to calculate dalisSuresi and cikisSuresi
			if (dt.speed == 1) {
				dalisSuresi = Math.round((dt.setDerinlik * 10) / 0.4);
				cikisSuresi = Math.round((dt.setDerinlik * 10) / 0.4);
			} else if (dt.speed == 2) {
				dalisSuresi = Math.round((dt.setDerinlik * 10) / 0.5);
				cikisSuresi = Math.round((dt.setDerinlik * 10) / 0.5);
			} else if (dt.speed == 3) {
				dalisSuresi = Math.round((dt.setDerinlik * 10) / 0.66666666);
				cikisSuresi = Math.round((dt.setDerinlik * 10) / 0.66666666);
			}

			sessionStatus.speed = dt.speed;

			sessionStatus.dalisSuresi = dalisSuresi;
			sessionStatus.cikisSuresi = cikisSuresi;
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
			let setProfile = [
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

function initializeO2Sensor() {
	try {
		o2Sensor = new SensorCalibration(
			{
				raw: o2CalibrationData.point0.raw,
				actual: o2CalibrationData.point0.percentage,
			},
			{
				raw: o2CalibrationData.point21.raw,
				actual: o2CalibrationData.point21.percentage,
			},
			{
				raw: o2CalibrationData.point100.raw,
				actual: o2CalibrationData.point100.percentage,
			}
		);
		console.log('O2 sensor calibration initialized successfully');
	} catch (error) {
		console.error('Error initializing O2 sensor calibration:', error);
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

// Her 3 saniyede bir livebit gÃ¶nder

function read() {
	// Sensor deÄerlerini al

	socket.emit('sensorData', {
		pressure: sensorData['pressure'],
		o2: sensorData['o2'],
		temperature: sensorData['temperature'],
		humidity: sensorData['humidity'],
		sessionStatus: sessionStatus,
		doorStatus: sessionStatus.doorStatus,
	});

	console.log(
		'status',
		sessionStatus.status,
		'zaman',
		sessionStatus.zaman,
		'grafikdurum',
		sessionStatus.grafikdurum
	);

	console.log(
		'Pressure : ',
		sensorData['pressure'],
		'O2 : ',
		sensorData['o2'],
		'Temperature : ',
		sensorData['temperature'],
		'Humidity : ',
		sensorData['humidity']
	);

	// Ensure profile is always an array before any indexed access
	if (!Array.isArray(sessionStatus.profile)) {
		sessionStatus.profile = [];
	}

	if (sessionStatus.status > 0) sessionStatus.zaman++;
	if (sessionStatus.status == 1 && sessionStatus.zaman == 1) {
		alarmSet('sessionStarting', 'Session Starting', 0);
		decompValve(0);
	}

	// Sistem aktifse kontrol et
	if (sessionStatus.status > 0 && sessionStatus.zaman > 5) {
		// Hedef basÄ±ncÄ± belirle
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

		// ÃÄ±kÄ±Å durumunda hedefi sÄ±fÄ±rla
		if (
			sessionStatus.zaman > sessionStatus.profile.length ||
			sessionStatus.cikis == 1
		) {
			sessionStatus.hedef = 0;
		}
		console.log('hedef : ', sessionStatus.hedef.toFixed(2));

		// Grafik durumunu belirle (yÃ¼kseliÅ/iniÅ/dÃ¼z)
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
				sessionStatus.grafikdurum = 0; // Ä°niÅ
			} else if (
				sessionStatus.profile[sessionStatus.zaman][1] <
				sessionStatus.profile[sessionStatus.zaman + 1][1]
			) {
				sessionStatus.grafikdurum = 1; // ÃÄ±kÄ±Å
			} else {
				sessionStatus.grafikdurum = 2; // DÃ¼z
			}
		} else {
			// If at end of profile, maintain current state or set to descent
			sessionStatus.grafikdurum = 0; // Default to descent when at end
		}

		// Profile bazlÄ± oksijen kontrolÃ¼
		if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.profile[sessionStatus.zaman + 1] &&
			sessionStatus.profile[sessionStatus.zaman][2] == 'air' &&
			sessionStatus.profile[sessionStatus.zaman + 1][2] == 'o' &&
			sessionStatus.oksijen == 0
		) {
			sessionStatus.oksijen = 1;
			alarmSet('oxygenBreak', 'Oxygen Starting. Put the mask on.', 0);
		} else if (
			sessionStatus.lastdurum === 2 &&
			sessionStatus.cikis == 0 &&
			sessionStatus.grafikdurum == 0
		) {
			sessionStatus.oksijen = 0;
			sessionStatus.oksijenBaslangicZamani = 0;
			sessionStatus.oksijenBitisZamani = 0;

			alarmSet(
				'treatmenFinished',
				'Treatment Finished. Take the mask off. Decompression Starting.',
				0
			);

			console.log(
				'DeÄiÅti : oksijen',
				sessionStatus.oksijen,
				'oksijenBaslangicZamani',
				sessionStatus.oksijenBaslangicZamani,
				'oksijenBitisZamani',
				sessionStatus.oksijenBitisZamani
			);
		} else if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.profile[sessionStatus.zaman + 1] &&
			sessionStatus.profile[sessionStatus.zaman][2] == 'o' &&
			sessionStatus.profile[sessionStatus.zaman + 1][2] == 'air' &&
			sessionStatus.oksijen == 1
		) {
			sessionStatus.oksijen = 0;

			alarmSet('oxygenBreak', 'Oxygen Stopped. Take the mask off.', 0);
		}

		// Check if step (adÄ±m) has changed
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

		// AdÄ±m kontrolÃ¼
		if (
			sessionStatus.grafikdurum != sessionStatus.lastdurum &&
			sessionStatus.wait == 0
		) {
			sessionStatus.p2counter = 0;
		}

		if (sessionStatus.profile[sessionStatus.zaman]) {
			sessionStatus.adim = sessionStatus.profile[sessionStatus.zaman][2];
		}

		// Gecikme kontrolÃ¼ - YÃ¼kseliÅ sÄ±rasÄ±nda hedef basÄ±nca ulaÅÄ±lamadÄ±ysa
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

		// // Gecikme kontrolÃ¼ - Ä°niÅ sÄ±rasÄ±nda hedef basÄ±ncÄ±n Ã¼zerindeyse
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

		// // Gecikme bitirme kontrolÃ¼
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

		// Gecikme sÄ±rasÄ±nda hedefi gÃ¼ncelle
		// if (sessionStatus.wait == 1 || sessionStatus.wait == 2) {
		//     if (sessionStatus.wait == 2) sessionStatus.grafikdurum = 0;
		//     sessionStatus.hedeflenen[sessionStatus.zaman + 1] = sessionStatus.targetmax;
		//     sessionStatus.counter++;
		// }

		// Zaman hesaplamalarÄ±
		var s = sessionStatus.zaman % 60;
		var m = parseInt(sessionStatus.zaman / 60);

		sessionStatus.p2counter++;

		// Global deÄiÅkenleri gÃ¼ncelle
		sessionStatus.fsw = sessionStatus.main_fsw;
		sessionStatus.fswd = sessionStatus.main_fswd;

		// Fark hesaplama
		var difference =
			parseFloat(sessionStatus.hedef) - parseFloat(sessionStatus.main_fsw);
		sessionStatus.bufferdifference[sessionStatus.zaman] = difference;
		sessionStatus.olcum.push(sessionStatus.main_fsw);

		// Update pressurization rate metrics
		const rateFsw = computePressurizationRate(60);
		sessionStatus.pressRateFswPerMin = rateFsw;
		sessionStatus.pressRateBarPerMin = rateFsw / 33.4;

		console.log(
			'pressRateFswPerMin :',
			sessionStatus.pressRateFswPerMin,
			'pressRateBarPerMin :',
			sessionStatus.pressRateBarPerMin
		);

		console.log('difference :', difference);

		console.log(
			'pressure :',
			sessionStatus.pressure,
			sessionStatus.fsw.toFixed(2)
		);

		// Ä°lk basÄ±nÃ§ kaydÄ±
		if (sessionStatus.zaman == 1) {
			sessionStatus.ilkbasinc = sessionStatus.fsw;
		}

		// UyarÄ± kontrolÃ¼
		if (sessionStatus.zaman > 0) {
			// Periyodik uyarÄ±lar
			// if (sessionStatus.zaman % sessionStatus.sesliuyari == 0 && sessionStatus.uyaridurum == 0) {
			//     showalert('Operator Shouldnt Away From The Panel !', 0);
			//     sessionStatus.uyaridurum = 1;
			// }
			// if (sessionStatus.zaman % sessionStatus.goreseluyari == 0 && sessionStatus.uyaridurum == 0) {
			//     showalert('Operator Shouldnt Away From The Panel !', 1);
			//     sessionStatus.uyaridurum = 1;
			// }

			// Sapma uyarÄ±sÄ±
			if (Math.abs(sessionStatus.bufferdifference[sessionStatus.zaman]) > 5) {
				sessionStatus.diffrencesayac++;
			}

			if (
				sessionStatus.diffrencesayac > 10 &&
				sessionStatus.otomanuel == 0 &&
				sessionStatus.deviationAlarm == false
			) {
				alarmSet(
					'deviation',
					'Session paused ! Deviation in the session graph ! Check the compressor and air supply system.',
					0
				);

				sessionStatus.status = 2;
				sessionStatus.otomanuel = 1;
				sessionStatus.pauseTime = sessionStatus.zaman;
				sessionStatus.pauseDepth = sensorData['pressure'];
				compValve(0);
				decompValve(35);
				compValve(0);
				setTimeout(() => {
					decompValve(0);
				}, 15000);

				console.log(
					'sessionPause',
					sessionStatus.pauseTime,
					sessionStatus.pauseDepth
				);

				sessionStatus.deviationAlarm = true;
				setTimeout(() => {
					sessionStatus.deviationAlarm = false;
					sessionStatus.diffrencesayac = 0;
				}, 600000);
			}

			// Otomatik kontrol
			if (
				sessionStatus.otomanuel == 0 &&
				sessionStatus.cikis == 0 &&
				sessionStatus.wait == 0
			) {
				// O2/Hava kontrolÃ¼

				// PID kontrolÃ¼ iÃ§in ortalama fark hesapla
				var avgDifference =
					(sessionStatus.bufferdifference[sessionStatus.zaman] +
						sessionStatus.bufferdifference[sessionStatus.zaman - 1] +
						sessionStatus.bufferdifference[sessionStatus.zaman - 2]) /
					3;

				console.log('avgDiff', avgDifference.toFixed(2));

				// KompresÃ¶r kontrolÃ¼
				sessionStatus.pcontrol =
					sessionStatus.comp_offset +
					sessionStatus.comp_gain * difference +
					sessionStatus.fsw / sessionStatus.comp_depth;
				if (sessionStatus.pcontrol < sessionStatus.minimumvalve)
					sessionStatus.pcontrol = sessionStatus.minimumvalve;

				// Dekompresyon kontrolÃ¼
				var control =
					sessionStatus.decomp_offset -
					sessionStatus.decomp_gain * difference +
					sessionStatus.decomp_depth / sessionStatus.fsw;

				// Vana kontrolÃ¼
				if (sessionStatus.ventil == 0) {
					if (sessionStatus.grafikdurum == 1) {
						// YÃ¼kseliÅ
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
						// DÃ¼z
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
						// Ä°niÅ
						compValve(0);
						decompValve(Math.abs(control));
					}
				}
			}

			// Ventilasyon kontrolÃ¼
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

			// ÃÄ±kÄ±Å durumu
			if (sessionStatus.cikis == 1) decompValve(90);

			// YÃ¼ksek oksijen kontrolÃ¼
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
			// Seans sonu kontrolÃ¼
			if (
				(sessionStatus.zaman > sessionStatus.profile.length - 60 ||
					sessionStatus.cikis == 1) &&
				sessionStatus.eop == 0 &&
				sessionStatus.main_fsw <= 0.9
			) {
				sessionStatus.eop = 1;
				alarmSet('endOfSession', 'Session Finished.', 0);
				decompValve(90);
				compValve(0);
				compValve(0);
				sessionStartBit(0);
				//doorOpen();
				sessionStatus.durum = 0;
				sessionStatus.uyariyenile = 1;
				sessionStatus.uyaridurum = 1;
				// Seans sonu varsayılanlarını doğrudan alanlara ata
				// setDerinlik, speed, toplamSure, dalisSuresi, cikisSuresi korunur
				const savedSetDerinlik = sessionStatus.setDerinlik;
				const savedSpeed = sessionStatus.speed;
				const savedToplamSure = sessionStatus.toplamSure;
				const savedDalisSuresi = sessionStatus.dalisSuresi;
				const savedCikisSuresi = sessionStatus.cikisSuresi;

				sessionStatus.status = 0; // 0: session durumu yok, 1: session başlatıldı, 2: session duraklatıldı, 3: session durduruldu
				sessionStatus.zaman = 0;
				sessionStatus.cikis = 0;
				sessionStatus.grafikdurum = 0;
				sessionStatus.adim = 0;
				sessionStatus.hedef = 0;
				sessionStatus.lastdurum = 0;
				sessionStatus.wait = 0;
				sessionStatus.p2counter = 0;
				sessionStatus.tempadim = 0;
				sessionStatus.otomanuel = 0;
				sessionStatus.diffrencesayac = 0;
				sessionStatus.higho = 0;
				sessionStatus.highoc = 0;
				sessionStatus.higho2 = 0;
				sessionStatus.pauseTime = 0;
				sessionStatus.starttime = 0;
				sessionStatus.pausetime = 0;
				sessionStatus.ilksure = 0;
				sessionStatus.ilkfsw = 0;
				sessionStatus.fswd = 0;
				sessionStatus.pauseDepteh = 0;
				sessionStatus.doorSensorStatus = 0;
				sessionStatus.doorStatus = 0;
				sessionStatus.pressure = 0;
				sessionStatus.o2 = 0;
				sessionStatus.bufferdifference = [];
				sessionStatus.olcum = [];
				sessionStatus.ventil = 0;
				sessionStatus.pcontrol = 0;
				sessionStatus.eop = 0;
				sessionStatus.uyariyenile = 0;
				// Oksijen molası için eklenen değişkenler
				sessionStatus.duzGrafikBaslangicZamani = 0;
				sessionStatus.sonOksijenMolasi = 0;
				sessionStatus.oksijenMolasiAktif = false;
				sessionStatus.oksijen = 0;
				sessionStatus.oksijenBaslangicZamani = 0;
				sessionStatus.oksijenBitisZamani = 0;
				// Basınç oranı hesaplama için
				sessionStatus.pressRateFswPerMin = 0;
				sessionStatus.pressRateBarPerMin = 0;
				// Deviation alarm için
				sessionStatus.deviationAlarm = false;

				// Korunan değerleri geri yükle
				sessionStatus.setDerinlik = savedSetDerinlik;
				sessionStatus.speed = savedSpeed;
				sessionStatus.toplamSure = savedToplamSure;
				sessionStatus.dalisSuresi = savedDalisSuresi;
				sessionStatus.cikisSuresi = savedCikisSuresi;
			}
		}

		// GÃ¶rÃ¼ntÃ¼leme deÄeri hesapla
		var displayValue = sessionStatus.main_fsw;
		if (
			Math.abs(difference) < 2.5 &&
			sessionStatus.profile[sessionStatus.zaman]
		) {
			displayValue = sessionStatus.profile[sessionStatus.zaman][1];
		}

		// Zaman gÃ¶rÃ¼ntÃ¼leme
		var m_display = zeroPad(parseInt(sessionStatus.zaman / 60), 2);
		var s_display = zeroPad(sessionStatus.zaman % 60, 2);
		//document.getElementById('time').innerHTML = '<h3>' + m_display + ':' + s_display + '</h3>';
		//document.getElementById('carpan').innerHTML = sessionStatus.pcontrol + '-' + sessionStatus.manuelcompangel + '-' + sessionStatus.starttime + '-' + sessionStatus.pausetime;

		// SensÃ¶r verilerini kaydet

		// Gauge gÃ¼ncelle

		// YÃ¼ksek oksijen kontrolÃ¼

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
		'status',
		sessionStatus.status,
		'zaman',
		sessionStatus.zaman,
		'grafikdurum',
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
		// Simulate pressure based on profile (demo mode)
		if (
			sessionStatus.profile.length > sessionStatus.zaman &&
			sessionStatus.profile[sessionStatus.zaman]
		) {
			const rawPressure = sessionStatus.profile[sessionStatus.zaman][1];
			sensorData['pressure'] = filters.pressure.update(rawPressure);
			sessionStatus.hedef =
				sessionStatus.profile[sessionStatus.zaman][1] * 33.4;
		} else if (
			sessionStatus.profile.length > 0 &&
			sessionStatus.profile[sessionStatus.profile.length - 1]
		) {
			const rawPressure =
				sessionStatus.profile[sessionStatus.profile.length - 1][1];
			sensorData['pressure'] = filters.pressure.update(rawPressure);
			sessionStatus.hedef =
				sessionStatus.profile[sessionStatus.profile.length - 1][1] * 33.4;
		} else {
			sensorData['pressure'] = filters.pressure.update(0);
			sessionStatus.hedef = 0;
		}

		// Simulate other sensor data
		sensorData['o2'] = filters.o2.update(21.1);
		sensorData['temperature'] = filters.temperature.update(
			22.5 + (Math.random() * 2 - 1)
		); // 21.5-23.5Â°C
		sensorData['humidity'] = filters.humidity.update(
			45 + (Math.random() * 10 - 5)
		); // 40-50%
		sensorData['pressure'] = filters.pressure.update(0);

		// Update session status with simulated data
		sessionStatus.pressure = sessionStatus.hedef / 33.4;
		sessionStatus.main_fsw = sessionStatus.hedef / 33.4;
		sensorData['pressure'] = filters.pressure.update(
			sessionStatus.hedef / 33.4
		);
		sessionStatus.o2 = sensorData['o2'];

		// ÃÄ±kÄ±Å durumunda hedefi sÄ±fÄ±rla
		if (
			sessionStatus.zaman > sessionStatus.profile.length ||
			sessionStatus.cikis == 1
		) {
			sessionStatus.hedef = 0;
		}

		console.log('hedef (demo): ', sessionStatus.hedef.toFixed(2));

		// Grafik durumunu belirle (yÃ¼kseliÅ/iniÅ/dÃ¼z)
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
				sessionStatus.grafikdurum = 0; // Ä°niÅ
			} else if (
				sessionStatus.profile[sessionStatus.zaman][1] <
				sessionStatus.profile[sessionStatus.zaman + 1][1]
			) {
				sessionStatus.grafikdurum = 1; // ÃÄ±kÄ±Å
			} else {
				sessionStatus.grafikdurum = 2; // DÃ¼z
			}
		} else {
			sessionStatus.grafikdurum = 0; // Default to descent when at end
		}

		// Profile bazlÄ± oksijen kontrolÃ¼ (demo mode)
		if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.profile[sessionStatus.zaman + 1] &&
			sessionStatus.profile[sessionStatus.zaman][2] == 'air' &&
			sessionStatus.profile[sessionStatus.zaman + 1][2] == 'o' &&
			sessionStatus.oksijen == 0
		) {
			sessionStatus.oksijen = 1;
			alarmSet('oxygenBreak', 'Oxygen Starting. Put the mask on.', 0);
		} else if (
			sessionStatus.lastdurum === 2 &&
			sessionStatus.cikis == 0 &&
			sessionStatus.grafikdurum == 0
		) {
			sessionStatus.oksijen = 0;
			sessionStatus.oksijenBaslangicZamani = 0;
			sessionStatus.oksijenBitisZamani = 0;

			alarmSet(
				'treatmenFinished',
				'Treatment Finished. Take the mask off. Decompression Starting.',
				0
			);

			console.log(
				'DeÄiÅti : oksijen',
				sessionStatus.oksijen,
				'oksijenBaslangicZamani',
				sessionStatus.oksijenBaslangicZamani,
				'oksijenBitisZamani',
				sessionStatus.oksijenBitisZamani
			);
		} else if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.profile[sessionStatus.zaman + 1] &&
			sessionStatus.profile[sessionStatus.zaman][2] == 'o' &&
			sessionStatus.profile[sessionStatus.zaman + 1][2] == 'air' &&
			sessionStatus.oksijen == 1
		) {
			sessionStatus.oksijen = 0;

			alarmSet('oxygenBreak', 'Oxygen Stopped. Take the mask off.', 0);
		}

		// Check if step (adÄ±m) has changed
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

		// AdÄ±m kontrolÃ¼
		if (
			sessionStatus.grafikdurum != sessionStatus.lastdurum &&
			sessionStatus.wait == 0
		) {
			sessionStatus.p2counter = 0;
		}

		if (sessionStatus.profile[sessionStatus.zaman]) {
			sessionStatus.adim = sessionStatus.profile[sessionStatus.zaman][2];
		}

		// Zaman hesaplamalarÄ±
		var s = sessionStatus.zaman % 60;
		var m = parseInt(sessionStatus.zaman / 60);

		sessionStatus.p2counter++;

		// Global deÄiÅkenleri gÃ¼ncelle
		sessionStatus.fsw = sessionStatus.main_fsw;
		sessionStatus.fswd = sessionStatus.main_fswd;

		// Fark hesaplama
		var difference =
			parseFloat(sessionStatus.hedef) - parseFloat(sessionStatus.main_fsw);
		sessionStatus.bufferdifference[sessionStatus.zaman] = difference;
		sessionStatus.olcum.push(sessionStatus.main_fsw);

		// Update pressurization rate metrics (demo flow)
		const rateFsw = computePressurizationRate(60);
		sessionStatus.pressRateFswPerMin = rateFsw;
		sessionStatus.pressRateBarPerMin = rateFsw / 33.4;

		console.log('difference (demo):', difference);
		console.log(
			'pressure (demo):',
			sessionStatus.pressure,
			sessionStatus.fsw.toFixed(2)
		);

		// Ä°lk basÄ±nÃ§ kaydÄ±
		if (sessionStatus.zaman == 1) {
			sessionStatus.ilkbasinc = sessionStatus.fsw;
		}

		// UyarÄ± kontrolÃ¼
		if (sessionStatus.zaman > 0) {
			// Sapma uyarÄ±sÄ±
			if (Math.abs(sessionStatus.bufferdifference[sessionStatus.zaman]) > 5) {
				sessionStatus.diffrencesayac++;
			}

			// Otomatik kontrol (simulated)
			if (
				sessionStatus.otomanuel == 0 &&
				sessionStatus.cikis == 0 &&
				sessionStatus.wait == 0
			) {
				// PID kontrolÃ¼ iÃ§in ortalama fark hesapla
				var avgDifference =
					(sessionStatus.bufferdifference[sessionStatus.zaman] +
						sessionStatus.bufferdifference[sessionStatus.zaman - 1] +
						sessionStatus.bufferdifference[sessionStatus.zaman - 2]) /
					3;

				console.log('avgDiff (demo)', avgDifference.toFixed(2));

				// KompresÃ¶r kontrolÃ¼ (simulated)
				sessionStatus.pcontrol =
					sessionStatus.comp_offset +
					sessionStatus.comp_gain * difference +
					sessionStatus.fsw / sessionStatus.comp_depth;
				if (sessionStatus.pcontrol < sessionStatus.minimumvalve)
					sessionStatus.pcontrol = sessionStatus.minimumvalve;

				// Dekompresyon kontrolÃ¼ (simulated)
				var control =
					sessionStatus.decomp_offset -
					sessionStatus.decomp_gain * difference +
					sessionStatus.decomp_depth / sessionStatus.fsw;

				// Vana kontrolÃ¼ (simulated - no actual hardware commands)
				if (sessionStatus.ventil == 0) {
					if (sessionStatus.grafikdurum == 1) {
						// YÃ¼kseliÅ
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
						// DÃ¼z
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
						// Ä°niÅ
						console.log('Demo: Would open decomp valve to', Math.abs(control));
					}
				}
			}

			// Ventilasyon kontrolÃ¼ (simulated)
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

			// ÃÄ±kÄ±Å durumu
			if (sessionStatus.cikis == 1) {
				console.log('Demo: Would open decomp valve to 90');
			}

			// YÃ¼ksek oksijen kontrolÃ¼ (simulated)
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

			// Seans sonu kontrolÃ¼
			if (
				(sessionStatus.zaman > sessionStatus.profile.length - 60 ||
					sessionStatus.cikis == 1) &&
				sessionStatus.eop == 0 &&
				sessionStatus.main_fsw <= 0.5
			) {
				sessionStatus.eop = 1;
				alarmSet('endOfSession', 'Session Finished.', 0);
				sessionStartBit(0);
				//doorOpen();
				// Seans sonu varsayılanlarını doğrudan alanlara ata
				// setDerinlik, speed, toplamSure, dalisSuresi, cikisSuresi korunur
				const savedSetDerinlik = sessionStatus.setDerinlik;
				const savedSpeed = sessionStatus.speed;
				const savedToplamSure = sessionStatus.toplamSure;
				const savedDalisSuresi = sessionStatus.dalisSuresi;
				const savedCikisSuresi = sessionStatus.cikisSuresi;

				sessionStatus.status = 0;
				sessionStatus.uyariyenile = 1;
				sessionStatus.uyaridurum = 1;
				sessionStatus.zaman = 0;
				sessionStatus.cikis = 0;
				sessionStatus.grafikdurum = 0;
				sessionStatus.adim = 0;
				sessionStatus.hedef = 0;
				sessionStatus.lastdurum = 0;
				sessionStatus.wait = 0;
				sessionStatus.p2counter = 0;
				sessionStatus.tempadim = 0;
				sessionStatus.otomanuel = 0;
				sessionStatus.diffrencesayac = 0;
				sessionStatus.higho = 0;
				sessionStatus.highoc = 0;
				sessionStatus.higho2 = 0;
				sessionStatus.pauseTime = 0;
				sessionStatus.starttime = 0;
				sessionStatus.pausetime = 0;
				sessionStatus.ilksure = 0;
				sessionStatus.ilkfsw = 0;
				sessionStatus.fswd = 0;
				sessionStatus.pauseDepteh = 0;
				sessionStatus.doorSensorStatus = 0;
				sessionStatus.doorStatus = 0;
				sessionStatus.pressure = 0;
				sessionStatus.o2 = 0;
				sessionStatus.bufferdifference = [];
				sessionStatus.olcum = [];
				sessionStatus.ventil = 0;
				sessionStatus.pcontrol = 0;
				sessionStatus.eop = 0;
				sessionStatus.uyariyenile = 0;
				// Oksijen molası için eklenen değişkenler
				sessionStatus.duzGrafikBaslangicZamani = 0;
				sessionStatus.sonOksijenMolasi = 0;
				sessionStatus.oksijenMolasiAktif = false;
				sessionStatus.oksijen = 0;
				sessionStatus.oksijenBaslangicZamani = 0;
				sessionStatus.oksijenBitisZamani = 0;
				// Basınç oranı hesaplama için
				sessionStatus.pressRateFswPerMin = 0;
				sessionStatus.pressRateBarPerMin = 0;
				// Deviation alarm için
				sessionStatus.deviationAlarm = false;

				// Korunan değerleri geri yükle
				sessionStatus.setDerinlik = savedSetDerinlik;
				sessionStatus.speed = savedSpeed;
				sessionStatus.toplamSure = savedToplamSure;
				sessionStatus.dalisSuresi = savedDalisSuresi;
				sessionStatus.cikisSuresi = savedCikisSuresi;
			}
		}

		// GÃ¶rÃ¼ntÃ¼leme deÄeri hesapla
		var displayValue = sessionStatus.main_fsw;
		if (
			Math.abs(difference) < 2.5 &&
			sessionStatus.profile[sessionStatus.zaman]
		) {
			displayValue = sessionStatus.profile[sessionStatus.zaman][1];
		}

		// Zaman gÃ¶rÃ¼ntÃ¼leme
		var m_display = zeroPad(parseInt(sessionStatus.zaman / 60), 2);
		var s_display = zeroPad(sessionStatus.zaman % 60, 2);

		console.log('Demo time:', m_display + ':' + s_display);
		console.log('');

		// YÃ¼ksek oksijen kontrolÃ¼ (simulated)
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

	// Her saniye iÃ§in deÄer hesapla
	for (let t = 0; t <= duration * 60; t++) {
		// DoÄrusal interpolasyon formÃ¼lÃ¼: start + (end - start) * (t / duration)
		const progress = t / (duration * 60);
		const value = startValue + (endValue - startValue) * progress;

		result.push({
			time: t,
			value: Math.round(value * 1000) / 1000, // 3 ondalÄ±k basamaÄa yuvarla
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
	buzzerOff();
	socket.emit('writeBit', { register: 'M0400', value: 0 });
}

function doorClose() {
	socket.emit('writeBit', { register: 'M0100', value: 1 });
}

function doorOpen() {
	console.log('door Opening');
	socket.emit('writeBit', { register: 'M0100', value: 0 });
	sessionStatus.doorStatus = 0;
}

function buzzerOn() {
	console.log('Buzzer On');
	socket.emit('writeBit', { register: 'M0101', value: 1 });
	sessionStatus.doorStatus = 0;
}

function buzzerOff() {
	console.log('Buzzer Off');
	socket.emit('writeBit', { register: 'M0101', value: 0 });
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

	var send = linearConversion(4000, 16383, 0, 90, angle, 0); //(32767/90derece)

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

function sessionFinishToZero(startTimeOverride, currentPressureOverride) {
	// Start from current session time if not provided
	const startTime = Number.isFinite(startTimeOverride)
		? startTimeOverride
		: sessionStatus.zaman;

	// Use live sensor pressure if available, else from profile, else 0
	let currentPressure = Number.isFinite(currentPressureOverride)
		? currentPressureOverride
		: typeof sensorData !== 'undefined' &&
		  Number.isFinite(sensorData['pressure'])
		? sensorData['pressure']
		: sessionStatus.profile[startTime]
		? sessionStatus.profile[startTime][1]
		: 0;

	if (!Array.isArray(sessionStatus.profile)) sessionStatus.profile = [];
	// originalLength removed; we will truncate instead of filling with zeros

	// Determine step index to keep series consistent
	let stepIndexVal = 1;
	if (
		sessionStatus.profile[startTime] &&
		sessionStatus.profile[startTime].length >= 4
	) {
		stepIndexVal = sessionStatus.profile[startTime][3];
	} else if (
		startTime > 0 &&
		sessionStatus.profile[startTime - 1] &&
		sessionStatus.profile[startTime - 1].length >= 4
	) {
		stepIndexVal = sessionStatus.profile[startTime - 1][3];
	}

	// Estimate per-second slope from the last 30 seconds
	let slope = 0;

	if (sessionStatus.speed == 1) slope = 0.5;
	else if (sessionStatus.speed == 2) slope = 1;
	else if (sessionStatus.speed == 3) slope = 3;

	// Guard against zero/NaN: derive a reasonable fallback from current pressure

	currentPressure = Math.max(0, Number(currentPressure || 0));
	console.log('currentPressure', currentPressure);

	if (currentPressure === 0) {
		// Already at zero; still set one zero point for consistency
		sessionStatus.profile[startTime] = [startTime + 1, 0, 'air', stepIndexVal];
		// Remove any remaining planned points after this zero point
		sessionStatus.profile.length = startTime + 1;
		return;
	}

	let timeToZero = Math.ceil((currentPressure * 10) / slope) * 60;
	if (!isFinite(timeToZero) || timeToZero < 1) timeToZero = 1;

	for (let s = 0; s < timeToZero; s++) {
		const idx = startTime + s;
		const ratio = (s + 1) / timeToZero; // 0->1
		const p = Math.max(0, currentPressure * (1 - ratio));
		sessionStatus.profile[idx] = [
			idx + 1,
			Number(p.toFixed(4)),
			'air',
			stepIndexVal,
		];
	}

	// Ensure last point is exactly zero
	const lastIdx = startTime + timeToZero - 1;
	sessionStatus.profile[lastIdx] = [lastIdx + 1, 0, 'air', stepIndexVal];

	// Remove any remaining planned points after reaching zero
	sessionStatus.profile.length = lastIdx + 1;

	console.log(
		'Session finish profile generated to zero starting at',
		startTime,
		'with',
		timeToZero,
		'seconds.'
	);
}

function sessionStop() {
	console.log('Session stop initiated at time:', sessionStatus.zaman);

	// Set exit mode (equivalent to cikis=3 in PHP)
	compValve(0);
	decompValve(0);
	sessionFinishToZero();

	// toplamSure korunur - profil uzunluğuna göre güncellenmez
	// Kullanıcının set ettiği duration değeri korunur

	sessionStatus.oksijen = 0;
	sessionStatus.oksijenBaslangicZamani = 0;
	sessionStatus.oksijenBitisZamani = 0;

	// Convert profile to hedeflenen array format (depth values only)

	// Set exit flag for valve control
	//sessionStatus.cikis = 1;

	alarmSet(
		'sessionStop',
		'Session stop initiated. Decompressing to surface.',
		0
	);
}

/**
 * Seans sÄ±rasÄ±nda sadece tedavi derinliÄini (orta faz) deÄiÅtiren fonksiyon
 * GiriÅ ve Ã§Ä±kÄ±Å hÄ±zlarÄ±nÄ±/deÄerlerini deÄiÅtirmez
 * @param {number} newDepth - Yeni tedavi derinliÄi (bar)
 */
function updateTreatmentDepth(newDepth) {
	if (!sessionStatus.profile || sessionStatus.profile.length === 0) {
		console.log('Profil bulunamadÄ±.');
		return false;
	}
	// Saniye bazlÄ± profil mi yoksa adÄ±m bazlÄ± mÄ± kontrol et
	// Saniye bazlÄ±: [zaman, basÄ±nÃ§, tip, adÄ±m]
	// AdÄ±m bazlÄ±: [dakika, basÄ±nÃ§, tip]
	sessionStatus.setDerinlik = newDepth;
	if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 4
	) {
		// Saniye bazlÄ± profil: adÄ±m numarasÄ± 2 olanlarÄ± gÃ¼ncelle
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
		// AdÄ±m bazlÄ± profil: sadece ortadaki adÄ±m(lar)Ä± gÃ¼ncelle
		if (sessionStatus.profile.length >= 3) {
			// Sadece 2. adÄ±m (index 1) gÃ¼ncellenir
			sessionStatus.profile[1][1] = newDepth;
		} else if (sessionStatus.profile.length === 1) {
			// Tek adÄ±m varsa, onu gÃ¼ncelle
			sessionStatus.profile[0][1] = newDepth;
		}
	} else {
		console.log('Profil formatÄ± tanÄ±namadÄ±.');
		return false;
	}
	// Gerekirse gÃ¼ncellenmiÅ profili frontend'e bildir

	console.log(`Tedavi derinliÄi ${newDepth} bar olarak gÃ¼ncellendi.`);
	return true;
}

/**
 * Toplam sÃ¼re deÄiÅtiÄinde dalÄ±Å ve Ã§Ä±kÄ±Å sÃ¼resi ile derinlik sabit kalacak Åekilde profili gÃ¼nceller
 * Sadece tedavi sÃ¼resi (orta faz) yeni toplam sÃ¼reye gÃ¶re ayarlanÄ±r
 * @param {number} newTotalDuration - Yeni toplam sÃ¼re (dakika)
 */
function updateTotalSessionDuration(newTotalDuration) {
	if (!sessionStatus.profile || sessionStatus.profile.length === 0) {
		console.log('Profil bulunamadÄ±.');
		return false;
	}
	const dalisSuresi = sessionStatus.dalisSuresi;
	const cikisSuresi = sessionStatus.cikisSuresi;
	const derinlik = sessionStatus.setDerinlik;
	const newTreatmentDuration = newTotalDuration - (dalisSuresi + cikisSuresi);
	if (newTreatmentDuration <= 0) {
		console.log(
			'Yeni toplam sÃ¼re, dalÄ±Å ve Ã§Ä±kÄ±Å sÃ¼relerinin toplamÄ±ndan bÃ¼yÃ¼k olmalÄ±.'
		);
		return false;
	}
	// AdÄ±m bazlÄ± profil: [dakika, basÄ±nÃ§, tip]
	if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 3
	) {
		if (sessionStatus.profile.length >= 3) {
			// Sadece 2. adÄ±mÄ±n sÃ¼resi gÃ¼ncellenir
			sessionStatus.profile[1][0] = newTreatmentDuration;
		} else if (sessionStatus.profile.length === 1) {
			// Tek adÄ±m varsa, onu gÃ¼ncelle
			sessionStatus.profile[0][0] = newTotalDuration;
		}
	}
	// Saniye bazlÄ± profil: [zaman, basÄ±nÃ§, tip, adÄ±m]
	else if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 4
	) {
		// GiriÅ ve Ã§Ä±kÄ±Å sÃ¼relerini saniyeye Ã§evir
		const dalisSaniye = Math.round(dalisSuresi * 60);
		const cikisSaniye = Math.round(cikisSuresi * 60);
		const tedaviSaniye = Math.round(newTreatmentDuration * 60);
		// Yeni profil dizisi oluÅtur
		const newProfile = [];
		let adim = 1;
		// GiriÅ fazÄ± (adÄ±m 1)
		for (let i = 0; i < dalisSaniye; i++) {
			const step = sessionStatus.profile[i];
			if (step && step[3] === 1) newProfile.push([...step]);
		}
		adim = 2;
		// Tedavi fazÄ± (adÄ±m 2)
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
		// ÃÄ±kÄ±Å fazÄ± (adÄ±m 3)
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
		console.log('Profil formatÄ± tanÄ±namadÄ±.');
		return false;
	}
	console.log(
		`Toplam sÃ¼re ${newTotalDuration} dakika olarak gÃ¼ncellendi. Tedavi sÃ¼resi: ${newTreatmentDuration} dakika.`
	);
	return true;
}

/**
 * DalÄ±Å ve Ã§Ä±kÄ±Å sÃ¼resi deÄiÅtiÄinde profili gÃ¼nceller
 * Toplam sÃ¼re ve derinlik sabit kalÄ±r, tedavi sÃ¼resi otomatik ayarlanÄ±r
 * @param {number} newDiveDuration - Yeni dalÄ±Å sÃ¼resi (dakika)
 * @param {number} newExitDuration - Yeni Ã§Ä±kÄ±Å sÃ¼resi (dakika)
 */
function updateDiveAndExitDurations(newDiveDuration, newExitDuration) {
	if (!sessionStatus.profile || sessionStatus.profile.length === 0) {
		console.log('Profil bulunamadÄ±.');
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
			'Yeni dalÄ±Å ve Ã§Ä±kÄ±Å sÃ¼relerinin toplamÄ±, toplam sÃ¼reden kÃ¼Ã§Ã¼k olmalÄ±.'
		);
		return false;
	}
	// AdÄ±m bazlÄ± profil: [dakika, basÄ±nÃ§, tip]
	if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 3
	) {
		if (sessionStatus.profile.length >= 3) {
			// 1. adÄ±m: dalÄ±Å sÃ¼resi
			sessionStatus.profile[0][0] = newDiveDuration;
			// 2. adÄ±m: tedavi sÃ¼resi
			sessionStatus.profile[1][0] = newTreatmentDuration;
			// 3. adÄ±m: Ã§Ä±kÄ±Å sÃ¼resi
			sessionStatus.profile[2][0] = newExitDuration;
		} else if (sessionStatus.profile.length === 1) {
			// Tek adÄ±m varsa, onu gÃ¼ncelle
			sessionStatus.profile[0][0] = totalDuration;
		}
	}
	// Saniye bazlÄ± profil: [zaman, basÄ±nÃ§, tip, adÄ±m]
	else if (
		Array.isArray(sessionStatus.profile[0]) &&
		sessionStatus.profile[0].length === 4
	) {
		const dalisSaniye = Math.round(newDiveDuration * 60);
		const cikisSaniye = Math.round(newExitDuration * 60);
		const tedaviSaniye = Math.round(newTreatmentDuration * 60);
		const newProfile = [];
		// GiriÅ fazÄ± (adÄ±m 1)
		const girisStep = sessionStatus.profile.find((step) => step[3] === 1);
		for (let i = 0; i < dalisSaniye; i++) {
			if (girisStep) {
				newProfile.push([newProfile.length + 1, girisStep[1], girisStep[2], 1]);
			}
		}
		// Tedavi fazÄ± (adÄ±m 2)
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
		// ÃÄ±kÄ±Å fazÄ± (adÄ±m 3)
		const cikisStep = sessionStatus.profile.find((step) => step[3] === 3);
		for (let i = 0; i < cikisSaniye; i++) {
			if (cikisStep) {
				newProfile.push([newProfile.length + 1, cikisStep[1], cikisStep[2], 3]);
			}
		}
		sessionStatus.profile = newProfile;
	} else {
		console.log('Profil formatÄ± tanÄ±namadÄ±.');
		return false;
	}
	// State gÃ¼ncelle
	sessionStatus.dalisSuresi = newDiveDuration;
	sessionStatus.cikisSuresi = newExitDuration;
	console.log(
		`DalÄ±Å sÃ¼resi ${newDiveDuration} dakika, Ã§Ä±kÄ±Å sÃ¼resi ${newExitDuration} dakika olarak gÃ¼ncellendi. Tedavi sÃ¼resi: ${newTreatmentDuration} dakika.`
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

function sensorCalibration() {}

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
			segments.push([oxygenDuration, depth, 'o']);
			remainingTime -= oxygenDuration;
		} else {
			// If less than 15 minutes remaining, use remaining time for oxygen
			segments.push([remainingTime, depth, 'o']);
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

function createChart() {
	const treatmentDuration =
		sessionStatus.toplamSure -
		(sessionStatus.dalisSuresi + sessionStatus.cikisSuresi);
	const safeTreatmentDuration = Math.max(
		0,
		Number.isFinite(treatmentDuration) ? treatmentDuration : 0
	);

	let treatmentSegments = createAlternatingTreatmentProfile(
		safeTreatmentDuration,
		sessionStatus.setDerinlik
	);
	if (sessionStatus.toplamSure == 80) {
		treatmentSegments = [
			[15, sessionStatus.setDerinlik, 'o'],
			[5, sessionStatus.setDerinlik, 'air'],
			[20, sessionStatus.setDerinlik, 'o'],
			[5, sessionStatus.setDerinlik, 'air'],
			[15, sessionStatus.setDerinlik, 'o'],
		];
	} else if (sessionStatus.toplamSure == 110) {
		treatmentSegments = [
			[20, sessionStatus.setDerinlik, 'o'],
			[5, sessionStatus.setDerinlik, 'air'],
			[20, sessionStatus.setDerinlik, 'o'],
			[5, sessionStatus.setDerinlik, 'air'],
			[20, sessionStatus.setDerinlik, 'o'],
			[5, sessionStatus.setDerinlik, 'air'],
			[15, sessionStatus.setDerinlik, 'o'],
		];
	}

	// Build complete profile with descent, alternating treatment, and ascent
	const setProfileRaw = [
		[sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air'], // Descent phase
		...treatmentSegments, // Alternating oxygen/air treatment phases
		[sessionStatus.cikisSuresi, 0, 'air'], // Ascent phase
	];

	// Filter out any invalid or non-positive duration segments to satisfy validator
	const setProfile = setProfileRaw.filter(
		(seg) => Array.isArray(seg) && Number.isFinite(seg[0]) && seg[0] > 0
	);

	const quickProfile = ProfileUtils.createQuickProfile(setProfile);
	sessionStatus.profile = quickProfile.toTimeBasedArrayBySeconds();

	// Export profile to JSON file
	const fs = require('fs');
	const profileData = JSON.stringify(sessionStatus.profile, null, 2);
	fs.writeFileSync('session_profile.json', profileData);

	//console.log(sessionStatus.profile);
}
