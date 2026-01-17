const net = require('net');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');

const app = express();
const http = require('http');
const { io } = require('socket.io-client');
const cors = require('cors');
const {
	linearConversion,
	checkInternetConnection,
	checkSystemHealth,
	updateSensor,
} = require('./src/helpers');
const db = require('./src/models');
const { ProfileUtils, ProfileManager } = require('./profile_manager_old');
const dayjs = require('dayjs');
let server = http.Server(app);
const bodyParser = require('body-parser');
const SensorCalibration = require('./o2_calibration');
const { sendCommand } = require('./src/ws/client');
const mqtt = require('mqtt');

const connections = []; // view soket bağlantılarının tutulduğu array
let isWorking = 0;
let isConnectedPLC = 0;
let sensorCalibrationData = {}; // Object to store all sensor calibration data
let demoMode = 0;
let currentSessionRecordId = null; // Aktif seans kaydı ID'si
let currentLoggedInUserId = null; // Giriş yapmış kullanıcı ID'si
let lastSensorUpdateTime = 0; // Son sensör güncelleme zamanı (timestamp)
const SENSOR_UPDATE_INTERVAL = 10000; // 10 saniye (milisaniye cinsinden)

// MQTT Client Configuration
let mqttClient = null;
const MQTT_CONFIG = {
	host: process.env.MQTT_HOST || 'u1691114.ala.eu-central-1.emqxsl.com',
	port: process.env.MQTT_PORT || 8883,
	protocol: 'mqtts', // TLS/SSL
	username: process.env.MQTT_USERNAME || 'arc02',
	password: process.env.MQTT_PASSWORD || 'Sencer77.',
	clientId:
		process.env.MQTT_CLIENT_ID ||
		`${process.env.MQTT_USERNAME || 'arco02'}-${Date.now()}`,
	reconnectPeriod: 5000,
	clean: true,
};
const MQTT_TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'hyperbaric/chamber';

// Insert default sensor data after sync
async function insertDefaultSensorData() {
	try {
		// Default sensor configurations
		const defaultSensors = [
			{
				sensorID: 1,
				sensorName: 'pressure',
				sensorText: 'Pressure',
				sensorMemory: 0,
				sensorSymbol: 'bar',
				sensorOffset: 0,
				sensorLowerLimit: 0,
				sensorUpperLimit: 2.5,
				sensorAnalogUpper: 16383,
				sensorAnalogLower: 3356,
				sensorDecimal: 2,
			},
			{
				sensorID: 2,
				sensorName: 'temperature',
				sensorText: 'Temperature',
				sensorMemory: 0,
				sensorSymbol: '°C',
				sensorOffset: 0,
				sensorLowerLimit: -40,
				sensorUpperLimit: 120,
				sensorAnalogUpper: 16383,
				sensorAnalogLower: 0,
				sensorDecimal: 1,
			},
			{
				sensorID: 3,
				sensorName: 'humidity',
				sensorText: 'Humidity',
				sensorMemory: 0,
				sensorSymbol: '%',
				sensorOffset: 0,
				sensorLowerLimit: 0,
				sensorUpperLimit: 100,
				sensorAnalogUpper: 16383,
				sensorAnalogLower: 0,
				sensorDecimal: 0,
			},
			{
				sensorID: 4,
				sensorName: 'o2',
				sensorText: 'O2',
				sensorMemory: 0,
				sensorSymbol: '%',
				sensorOffset: 0,
				sensorLowerLimit: 0,
				sensorUpperLimit: 100,
				sensorAnalogUpper: 16383,
				sensorAnalogLower: 3224,
				sensorDecimal: 1,
			},
			{
				sensorID: 5,
				sensorName: 'air_pressure',
				sensorText: 'Air Pressure',
				sensorMemory: 0,
				sensorSymbol: 'bar',
				sensorOffset: 0,
				sensorLowerLimit: 0,
				sensorUpperLimit: 16,
				sensorAnalogUpper: 16383,
				sensorAnalogLower: 3224,
				sensorDecimal: 1,
			},
			{
				sensorID: 6,
				sensorName: 'o2_pressure',
				sensorText: 'O2 Pressure',
				sensorMemory: 0,
				sensorSymbol: '°C',
				sensorOffset: 0,
				sensorLowerLimit: 0,
				sensorUpperLimit: 16,
				sensorAnalogUpper: 16383,
				sensorAnalogLower: 3224,
				sensorDecimal: 1,
			},
		];

		// Insert default sensors
		for (const sensorData of defaultSensors) {
			await db.sensors.create(sensorData);
		}

		console.log('Default sensor data inserted successfully');
	} catch (error) {
		console.error('Error inserting default sensor data:', error);
	}
}

// Initialize database and start application
(async () => {
	// SQLite: Foreign key constraint'leri geçici olarak devre dışı bırak
	await db.sequelize.query('PRAGMA foreign_keys = OFF;');
	
	// Eski backup tablolarını temizle
	try {
		await db.sequelize.query('DROP TABLE IF EXISTS Users_backup;');
	} catch (e) {
		// Tablo yoksa hata vermesin
	}
	
	await db.sequelize.sync({ alter: true });
	
	// Foreign key constraint'leri tekrar aktif et
	await db.sequelize.query('PRAGMA foreign_keys = ON;');
	
	//await insertDefaultSensorData();
	init();
})();
const allRoutes = require('./src/routes');

let sensorData = {};

let o2Timer = null;

// O2 Kalibrasyon verilerini saklamak için obje
let o2CalibrationData = {
	point0: { raw: 0, percentage: 0 }, // %0 O2 için analog değer
	point21: { raw: 828, percentage: 21 }, // %21 O2 için analog değer (varsayılan)
	point100: { raw: 16383, percentage: 100 }, // %100 O2 için analog değer
	isCalibrated: false,
	lastCalibrationDate: null,
	o2AlarmValuePercentage: 23.5,
	o2AlarmOn: false,
};

// O2 sensör kalibrasyon instance'ı
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
	higho2: false,
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
	patientWarning: false,

	o2: 0,
	bufferdifference: [],
	olcum: [],
	ventil: 0, // 0: kapalı, 1: düşük, 2: orta, 3: yüksek ventilasyon modu
	vanacikis: 30, // Ventilasyon şiddeti (decomp valve açıklığı, 0-90 derece)
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
	setDerinlik: 1,
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
	oksijen: 0,
	oksijenBaslangicZamani: 0,
	oksijenBitisZamani: 0,
	speed: 1,
	highHumidity: false,
	humidityAlarmLevel: 70,
	deviationAlarm: false,
	pressRateFswPerMin: 0,
	pressRateBarPerMin: 0,
	patientWarningStatus: 0,
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

// MQTT Connection Functions
function connectMQTT() {
	try {
		// MQTT bağlantı seçeneklerini hazırla
		const mqttOptions = {
			username: MQTT_CONFIG.username,
			password: MQTT_CONFIG.password,
			clientId: MQTT_CONFIG.clientId,
			reconnectPeriod: MQTT_CONFIG.reconnectPeriod,
			clean: MQTT_CONFIG.clean,
			connectTimeout: 10000,
			// TLS seçenekleri
			rejectUnauthorized: false, // Self-signed sertifikalar için
		};

		// CA sertifika dosyası varsa ekle
		const caPath = path.join(__dirname, 'emqxsl-ca.crt');
		if (fs.existsSync(caPath)) {
			mqttOptions.ca = fs.readFileSync(caPath);
		}

		mqttClient = mqtt.connect(
			`${MQTT_CONFIG.protocol}://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}`,
			mqttOptions
		);

		mqttClient.on('connect', (connack) => {
			// Bağlantı başarılı olduğunda status mesajı gönder
			publishToMQTT(`${MQTT_TOPIC_PREFIX}/status`, {
				status: 'online',
				clientId: MQTT_CONFIG.clientId,
				connectedAt: dayjs().toISOString(),
			});
		});

		mqttClient.on('error', (error) => {
			if (error.code === 5) {
				console.error('MQTT authentication error: Not authorized');
			} else {
				console.error('MQTT error:', error.message);
			}
		});
	} catch (error) {
		console.error('Failed to initialize MQTT client:', error);
		console.error('Error details:', error.stack);
	}
}

function publishToMQTT(topic, data) {
	if (!mqttClient || !mqttClient.connected) {
		return;
	}

	try {
		const payload = JSON.stringify({
			...data,
			timestamp: dayjs().toISOString(),
		});

		mqttClient.publish(topic, payload, { qos: 1 });
	} catch (error) {
		console.error(`Error publishing to MQTT topic ${topic}:`, error);
	}
}

function publishAllChamberData() {
	if (!mqttClient || !mqttClient.connected) {
		return;
	}

	try {
		// Sensor verileri
		const sensorDataPayload = {
			pressure: Number(sensorData['pressure']?.toFixed(2)) || 0,
			o2: Number(sensorData['o2']?.toFixed(1)) || 0,
			temperature: Number(sensorData['temperature']?.toFixed(1)) || 0,
			humidity: Number(sensorData['humidity']?.toFixed(0)) || 0,
			o2RawValue: sensorData.o2RawValue || 0,
		};

		// Session status verileri
		const sessionStatusPayload = {
			status: sessionStatus.status,
			zaman: sessionStatus.zaman,
			dalisSuresi: sessionStatus.dalisSuresi,
			cikisSuresi: sessionStatus.cikisSuresi,
			toplamSure: sessionStatus.toplamSure,
			setDerinlik: sessionStatus.setDerinlik,
			hedef: sessionStatus.hedef,
			grafikdurum: sessionStatus.grafikdurum,
			adim: sessionStatus.adim,
			otomanuel: sessionStatus.otomanuel,
			pressure: sessionStatus.pressure,
			main_fsw: sessionStatus.main_fsw,
			fsw: sessionStatus.fsw,
			o2: sessionStatus.o2,
			oksijen: sessionStatus.oksijen,
			oksijenBaslangicZamani: sessionStatus.oksijenBaslangicZamani,
			oksijenBitisZamani: sessionStatus.oksijenBitisZamani,
			speed: sessionStatus.speed,
			pressRateFswPerMin: sessionStatus.pressRateFswPerMin,
			pressRateBarPerMin: sessionStatus.pressRateBarPerMin,
			sessionStartTime: sessionStatus.sessionStartTime
				? dayjs(sessionStatus.sessionStartTime).toISOString()
				: null,
		};

		// Chamber status verileri
		const chamberStatusPayload = {
			chamberStatus: sessionStatus.chamberStatus,
			chamberStatusText: sessionStatus.chamberStatusText,
			chamberStatusTime: sessionStatus.chamberStatusTime,
			doorStatus: sessionStatus.doorStatus,
			doorSensorStatus: sessionStatus.doorSensorStatus,
			patientWarning: sessionStatus.patientWarning,
		};

		// Alarm verileri
		const alarmPayload = {
			status: alarmStatus.status,
			type: alarmStatus.type,
			text: alarmStatus.text,
			time: alarmStatus.time ? dayjs(alarmStatus.time).toISOString() : null,
			duration: alarmStatus.duration,
		};

		// Valve kontrol verileri
		const valveControlPayload = {
			pcontrol: sessionStatus.pcontrol,
			ventil: sessionStatus.ventil,
			vanacikis: sessionStatus.vanacikis,
			comp_offset: sessionStatus.comp_offset,
			comp_gain: sessionStatus.comp_gain,
			decomp_offset: sessionStatus.decomp_offset,
			decomp_gain: sessionStatus.decomp_gain,
		};

		// Tüm verileri yayınla
		publishToMQTT(`${MQTT_TOPIC_PREFIX}/sensors`, sensorDataPayload);
		publishToMQTT(`${MQTT_TOPIC_PREFIX}/session`, sessionStatusPayload);
		publishToMQTT(`${MQTT_TOPIC_PREFIX}/chamber`, chamberStatusPayload);
		publishToMQTT(`${MQTT_TOPIC_PREFIX}/alarm`, alarmPayload);
		publishToMQTT(`${MQTT_TOPIC_PREFIX}/valves`, valveControlPayload);

		// Tüm verileri tek bir topic'te de yayınla
		publishToMQTT(`${MQTT_TOPIC_PREFIX}/all`, {
			sensors: sensorDataPayload,
			session: sessionStatusPayload,
			chamber: chamberStatusPayload,
			alarm: alarmPayload,
			valves: valveControlPayload,
		});
	} catch (error) {
		console.error('Error publishing chamber data to MQTT:', error);
	}
}

// Load config values from database
async function loadConfigFromDB() {
	try {
		let config = await db.config.findOne();

		// Eğer config yoksa, varsayılan değerlerle oluştur
		if (!config) {
			config = await db.config.create({
				projectID: 'ARC-02',
				chamberType: 'monoplace',
				compOffset: 14,
				compGain: 8,
				compDepth: 100,
				decompOffset: 14,
				decompGain: 7,
				decompDepth: 100,
				minimumValve: 12,
				humidityAlarmLevel: 70,
				lastSessionDepth: 1.4,
				lastSessionDuration: 60,
				lastSessionSpeed: 1,
			});
			console.log('Default config created in database');
		}

		// Valve control parametrelerini sessionStatus'a ata
		sessionStatus.comp_offset = config.compOffset ?? 14;
		sessionStatus.comp_gain = config.compGain ?? 8;
		sessionStatus.comp_depth = config.compDepth ?? 100;
		sessionStatus.decomp_offset = config.decompOffset ?? 14;
		sessionStatus.decomp_gain = config.decompGain ?? 7;
		sessionStatus.decomp_depth = config.decompDepth ?? 100;
		sessionStatus.minimumvalve = config.minimumValve ?? 12;
		sessionStatus.humidityAlarmLevel = config.humidityAlarmLevel ?? 70;

		// Son seans ayarlarını sessionStatus'a ata
		sessionStatus.setDerinlik = config.lastSessionDepth ?? 1.4;
		sessionStatus.toplamSure = config.lastSessionDuration ?? 60;
		sessionStatus.speed = config.lastSessionSpeed ?? 1;

		console.log('Config loaded from database:', {
			comp_offset: sessionStatus.comp_offset,
			comp_gain: sessionStatus.comp_gain,
			decomp_offset: sessionStatus.decomp_offset,
			decomp_gain: sessionStatus.decomp_gain,
			minimumvalve: sessionStatus.minimumvalve,
			humidityAlarmLevel: sessionStatus.humidityAlarmLevel,
			lastSessionDepth: sessionStatus.setDerinlik,
			lastSessionDuration: sessionStatus.toplamSure,
			lastSessionSpeed: sessionStatus.speed,
		});

		// DalisSuresi ve CikisSuresi hesapla (speed değerine göre)
		let dalisSuresi = 0;
		let cikisSuresi = 0;
		if (sessionStatus.speed == 1) {
			dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
			cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
		} else if (sessionStatus.speed == 2) {
			dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 1);
			cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 1);
		} else if (sessionStatus.speed == 3) {
			dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 2);
			cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 2);
		}
		sessionStatus.dalisSuresi = dalisSuresi;
		sessionStatus.cikisSuresi = cikisSuresi;

		// Başlangıç grafiğini oluştur
		createChart();
		console.log('Initial chart created with saved settings');

		return config;
	} catch (error) {
		console.error('Error loading config from DB:', error);
		// Varsayılan değerleri kullan (sessionStatus'ta zaten tanımlı)
		return null;
	}
}

// Save last session settings to database
async function saveLastSessionSettings(depth, duration, speed) {
	try {
		const config = await db.config.findOne();
		if (config) {
			await config.update({
				lastSessionDepth: depth,
				lastSessionDuration: duration,
				lastSessionSpeed: speed,
			});
			console.log('Last session settings saved:', { depth, duration, speed });
		}
	} catch (error) {
		console.error('Error saving last session settings:', error);
	}
}

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
	await loadConfigFromDB();
	initializeO2Sensor();

	// Connect to MQTT broker
	connectMQTT();

	try {
		socket = io.connect('http://192.168.77.100:4000', { reconnect: true });
		socket.on('connect', function () {
			console.log('Connected to server');
			if (demoMode == 0) {
				//doorOpen();
				compValve(0);
				decompValve(0);
				sessionStartBit(0);
				oxygenClose();

				setInterval(() => {
					liveBit();
				}, 3000);
			}
			//socket.emit('writeRegister', JSON.stringify({address: "R03904", value: 8000}));
		});
		socket.on('disconnect', function () {
			console.log('Disconnected from server');
		});
		socket.on('data', async function (data) {
			if (demoMode == 1) {
				return;
			}
			//console.log('Received message:', data);
			const dataObject = JSON.parse(data);
			//console.log('length', dataObject.data.length);
			if (dataObject.data.length > 1) {
				sessionStatus.patientWarningStatus = dataObject.data[10];
				sessionStatus.doorSensorStatus = dataObject.data[11];

				if (
					sessionStatus.patientWarning == false &&
					sessionStatus.patientWarningStatus == 1
				) {
					socket.emit('writeBit', { register: 'M0200', value: 0 });
					alarmSet('patientWarning', 'Patient Warning', 0);
					sessionStatus.patientWarning = true;
				}

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
				//console.log('pressure',sessionStatus.pressure, dataObject.data[1]);
				//console.log(sensorData);

				// O2 sensörü için gerçek analog değeri oku (dataObject.data[2] varsayıyoruz)
				const o2RawValue = dataObject.data[2] || 8000; // Eğer veri yoksa varsayılan değer
				sensorData.o2RawValue = o2RawValue; // Ham değeri sakla
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

				// Sensör verilerini 10 saniyede bir güncelle
				const currentTime = Date.now();
				if (currentTime - lastSensorUpdateTime >= SENSOR_UPDATE_INTERVAL) {
					updateSensor(
						dataObject.data[1],
						sensorData['pressure'],
						dataObject.data[4],
						sensorData['temperature'],
						dataObject.data[2] || null, // O2 raw data
						sensorData['o2'], // O2 real data
						dataObject.data[5],
						sensorData['humidity']
					).catch((error) => {
						console.error('Sensör güncelleme hatası:', error);
					});
					lastSensorUpdateTime = currentTime;
				}

				if (dataObject.data[1] < 2000) {
					sessionStatus.chamberStatus = 0;
					sessionStatus.chamberStatusText = 'Pressure sensor problem';
					sessionStatus.chamberStatusTime = dayjs().format(
						'YYYY-MM-DD HH:mm:ss'
					);
				} else if (dataObject.data[4] < 800) {
					sessionStatus.chamberStatus = 0;
					sessionStatus.chamberStatusText = 'Temperature sensor problem';
					sessionStatus.chamberStatusTime = dayjs().format(
						'YYYY-MM-DD HH:mm:ss'
					);
				} else if (dataObject.data[5] < 800) {
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
				// console.log(
				// 	sessionStatus.chamberStatus,
				// 	sessionStatus.chamberStatusText,
				// 	sessionStatus.chamberStatusTime
				// );
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
			// Remote command bridge to signaling server
			if (dt && dt.type === 'remoteCommand') {
				const mapCmd = (cmd) =>
					cmd === 'play'
						? 'play_door_close'
						: cmd === 'stop'
						? 'stop_effect'
						: cmd;
				const { to, cmd, url, my, timeoutMs } = dt.data || {};
				sendCommand({
					url: url || process.env.SIGNALING_URL || 'ws://192.168.1.12:8080/ws',
					my: my || process.env.MY_ID || 'server-1',
					to: to || process.env.TO_ID || 'raspi-1',
					command: cmd || 'play',
					mapped: mapCmd(cmd || 'play'),
					timeoutMs: timeoutMs || 2000,
				})
					.then((result) => {
						console.log('remoteCommand result:', result);
						try {
							socket.emit('chamberControl', {
								type: 'remoteCommandResult',
								data: result,
							});
						} catch {}
					})
					.catch((err) => {
						console.error(
							'remoteCommand error:',
							err && err.message ? err.message : err
						);
						try {
							socket.emit('chamberControl', {
								type: 'remoteCommandResult',
								data: {
									ok: false,
									error: err && err.message ? err.message : String(err),
								},
							});
						} catch {}
					});
				return;
			}
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

				if (dt.data.dalisSuresi == 1) {
					dalisSuresi = Math.round((dt.data.setDerinlik * 10) / 0.5);
					cikisSuresi = Math.round((dt.data.setDerinlik * 10) / 0.5);
				} else if (dt.data.dalisSuresi == 2) {
					dalisSuresi = Math.round((dt.data.setDerinlik * 10) / 1);
					cikisSuresi = Math.round((dt.data.setDerinlik * 10) / 1);
				} else if (dt.data.dalisSuresi == 3) {
					dalisSuresi = Math.round((dt.data.setDerinlik * 10) / 2);
					cikisSuresi = Math.round((dt.data.setDerinlik * 10) / 2);
				}
				sessionStatus.dalisSuresi = dalisSuresi;
				sessionStatus.cikisSuresi = cikisSuresi;
				sessionStatus.toplamSure = dt.data.toplamSure;
				sessionStatus.setDerinlik = dt.data.setDerinlik;
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

				const treatmentDuration =
					sessionStatus.toplamSure -
					(sessionStatus.dalisSuresi + sessionStatus.cikisSuresi);

				let treatmentSegments = createAlternatingTreatmentProfile(
					treatmentDuration,
					sessionStatus.setDerinlik
				);



 			if (sessionStatus.toplamSure == 80 && sessionStatus.setDerinlik == 0.5 && sessionStatus.speed == 2) {
					treatmentSegments = [
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
					];
				}
				else if (sessionStatus.toplamSure == 80) {
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
				const setProfile = [
					[sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air'], // Descent phase
					...treatmentSegments, // Alternating oxygen/air treatment phases
					[sessionStatus.cikisSuresi, 0, 'air'], // Ascent phase
				];

				const quickProfile = ProfileUtils.createQuickProfile(setProfile);
				sessionStatus.profile = quickProfile.toTimeBasedArrayBySeconds();

				// Export profile to JSON file
				const fs = require('fs');
				const profileData = JSON.stringify(sessionStatus.profile, null, 2);
				fs.writeFileSync('session_profile.json', profileData);

				console.log(sessionStatus.profile);

				sessionStatus.status = 1;

				// Son seans ayarlarını kaydet
				saveLastSessionSettings(
					sessionStatus.setDerinlik,
					sessionStatus.toplamSure,
					sessionStatus.speed
				);

				socket.emit('chamberControl', {
					type: 'sessionStarting',
					data: {},
				});
				sessionStartBit(1);
				sessionStatus.sessionStartTime = dayjs();

				// Seans kaydını veritabanına oluştur
				createSessionRecord({
					setDerinlik: sessionStatus.setDerinlik,
					speed: sessionStatus.speed,
					toplamSure: sessionStatus.toplamSure,
				});
			} else if (dt.type == 'sessionPause') {
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
			} else if (dt.type == 'doorControl') {
				//{ type: 'doorControl', data: { direction: 'close', engage: true } }

				if (dt.data.direction == 'open' && dt.data.engage == true) {
					socket.emit('writeBit', { register: 'M0300', value: 1 });
				} else if (dt.data.direction == 'open' && dt.data.engage == false) {
					socket.emit('writeBit', { register: 'M0300', value: 0 });
				} else if (dt.data.direction == 'close' && dt.data.engage == true) {
					socket.emit('writeBit', { register: 'M0301', value: 1 });
				} else if (dt.data.direction == 'close' && dt.data.engage == false) {
					socket.emit('writeBit', { register: 'M0301', value: 0 });
				} else if (dt.data.direction == 'forward' && dt.data.engage == true) {
					socket.emit('writeBit', { register: 'M0302', value: 1 });
				} else if (dt.data.direction == 'forward' && dt.data.engage == false) {
					socket.emit('writeBit', { register: 'M0302', value: 0 });
				} else if (dt.data.direction == 'backward' && dt.data.engage == true) {
					socket.emit('writeBit', { register: 'M0303', value: 1 });
				} else if (dt.data.direction == 'backward' && dt.data.engage == false) {
					socket.emit('writeBit', { register: 'M0303', value: 0 });
				}
			} else if (dt.type == 'duration') {
				console.log('duration', dt.data.duration);
				sessionStatus.toplamSure = dt.data.duration;

				let dalisSuresi = 0;
				let cikisSuresi = 0;

				if (sessionStatus.speed == 1) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
				} else if (sessionStatus.speed == 2) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 1);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 1);
				} else if (sessionStatus.speed == 3) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 2);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 2);
				}

				sessionStatus.dalisSuresi = dalisSuresi;
				sessionStatus.cikisSuresi = cikisSuresi;

				if (sessionStatus.toplamSure == 80 && sessionStatus.setDerinlik == 0.5 && sessionStatus.speed == 2) {
					treatmentSegments = [
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
					];
				}
				else if (sessionStatus.toplamSure == 80) {
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

				createChart();
			} else if (dt.type == 'pressure') {
				sessionStatus.setDerinlik = dt.data.pressure;

				let dalisSuresi = 0;
				let cikisSuresi = 0;

				if (sessionStatus.speed == 1) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
				} else if (sessionStatus.speed == 2) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 1);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 1);
				} else if (sessionStatus.speed == 3) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 2);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 2);
				}

				sessionStatus.dalisSuresi = dalisSuresi;
				sessionStatus.cikisSuresi = cikisSuresi;
if (sessionStatus.toplamSure == 80 && sessionStatus.setDerinlik == 0.5 && sessionStatus.speed == 2) {
					treatmentSegments = [
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
					];
				}
				else if (sessionStatus.toplamSure == 80) {
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
				createChart();
			} else if (dt.type == 'speed') {
				console.log('speed', dt.data.speed);
				sessionStatus.speed = dt.data.speed;

				let dalisSuresi = 0;
				let cikisSuresi = 0;

				if (dt.data.speed == 1) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 0.5);
				} else if (dt.data.speed == 2) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 1);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 1);
				} else if (dt.data.speed == 3) {
					dalisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 2);
					cikisSuresi = Math.round((sessionStatus.setDerinlik * 10) / 2);
				}

				sessionStatus.dalisSuresi = dalisSuresi;
				sessionStatus.cikisSuresi = cikisSuresi;
				sessionStatus.speed = dt.data.speed;

				if (sessionStatus.toplamSure == 80 && sessionStatus.setDerinlik == 0.5 && sessionStatus.speed == 2) {
					treatmentSegments = [
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
					];
				}
				else if (sessionStatus.toplamSure == 80) {
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
			} else if (dt.type == 'fanSpeed') {
				if (dt.data.speed == 1) {
					console.log('fanSpeed 1');
					socket.emit(
						'writeRegister',
						JSON.stringify({ register: 'R01700', value: 50 })
					);
				} else if (dt.data.speed == 2) {
					socket.emit(
						'writeRegister',
						JSON.stringify({ register: 'R01700', value: 70 })
					);
				} else if (dt.data.speed == 3) {
					socket.emit(
						'writeRegister',
						JSON.stringify({ register: 'R01700', value: 100 })
					);
				} else if (dt.data.speed == 4) {
					socket.emit(
						'writeRegister',
						JSON.stringify({ register: 'R01700', value: 150 })
					);
				} else if (dt.data.speed == 0) {
					socket.emit(
						'writeRegister',
						JSON.stringify({ register: 'R01700', value: 0 })
					);
				}
			} else if (dt.type == 'ventilationStart') {
				// Ventilasyon başlat
				const mode = dt.data?.mode || 1;
				const intensity = dt.data?.intensity || null;
				const result = ventilationStart(mode, intensity);
				socket.emit('chamberControl', {
					type: 'ventilationStatus',
					data: result,
				});
			} else if (dt.type == 'ventilationStop') {
				// Ventilasyon durdur
				const result = ventilationStop();
				socket.emit('chamberControl', {
					type: 'ventilationStatus',
					data: result,
				});
			} else if (dt.type == 'ventilationSetIntensity') {
				// Ventilasyon şiddetini ayarla
				const intensity = dt.data?.intensity || 30;
				const result = ventilationSetIntensity(intensity);
				socket.emit('chamberControl', {
					type: 'ventilationStatus',
					data: result,
				});
			}
		});

		socket.on('sessionStart', function (data) {
			console.log('sessionStart', data);
			const dt = JSON.parse(data);
			let dalisSuresi = 0;
			let cikisSuresi = 0;
			if (dt.dalisSuresi == 1) {
				dalisSuresi = Math.round(dt.setDerinlik / 0.5);
				cikisSuresi = Math.round(dt.setDerinlik / 0.5);
			} else if (dt.dalisSuresi == 2) {
				dalisSuresi = Math.round(dt.setDerinlik / 1);
				cikisSuresi = Math.round(dt.setDerinlik / 1);
			} else if (dt.dalisSuresi == 3) {
				dalisSuresi = Math.round(dt.setDerinlik / 2);
				cikisSuresi = Math.round(dt.setDerinlik / 2);
			}

			sessionStatus.speed = dt.dalisSuresi;

			sessionStatus.dalisSuresi = dalisSuresi;
			sessionStatus.cikisSuresi = cikisSuresi;
			sessionStatus.toplamSure = dt.toplamSure;
			sessionStatus.setDerinlik = dt.setDerinlik;
			sessionStatus.status = 1;

			console.log(sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air');

			const middleDuration =
				sessionStatus.toplamSure -
				(sessionStatus.dalisSuresi + sessionStatus.cikisSuresi);
			const safeMiddle = Math.max(
				0,
				Number.isFinite(middleDuration) ? middleDuration : 0
			);
			const setProfileRaw = [
				[sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air'],
				[safeMiddle, sessionStatus.setDerinlik, 'air'],
				[sessionStatus.cikisSuresi, 0, 'air'],
			];
			const setProfile = setProfileRaw.filter(
				(seg) => Array.isArray(seg) && Number.isFinite(seg[0]) && seg[0] > 0
			);
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

		if (
			sensorData['o2'] > o2CalibrationData.o2AlarmValuePercentage &&
			!sessionStatus.higho2
		) {
			alarmSet('highO2', 'High O₂ level, ventilate the chamber.', 0);
			sessionStatus.higho2 = true;
			setTimeout(() => {
				sessionStatus.higho2 = false;
			}, 60000 * 10);
		}
		if (
			sensorData['humidity'] > sessionStatus.humidityAlarmLevel &&
			!sessionStatus.highHumidity
		) {
			alarmSet('highHumidity', 'High Humidity, ventilate the chamber.', 0);
			sessionStatus.highHumidity = true;
			setTimeout(() => {
				sessionStatus.highHumidity = false;
			}, 60000 * 10);
		}
	} else {
		// Demo modunda da aynı alan adlarında yumuşatılmış değerler gönder
		sensorData['o2'] = filters.o2.update(21.1);
		sensorData['temperature'] = filters.temperature.update(
			22.5 + (Math.random() * 2 - 1)
		); // 21.5-23.5°C
		sensorData['humidity'] = filters.humidity.update(
			45 + (Math.random() * 10 - 5)
		); // 40-50%
		sensorData['pressure'] = filters.pressure.update(0);
		read_demo();
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

	// Publish all chamber data to MQTT
	publishAllChamberData();

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

	// Seans aktifken sensör verilerini her saniye logla
	if (sessionStatus.status === 1) {
		logSessionSensorData();
	}

	if (sessionStatus.status == 1 && sessionStatus.zaman == 1) {
		//console.log('door closing');
		alarmSet('sessionStarting', 'Session Starting', 0);
		sendCommand({
			url: 'ws://192.168.77.100:8080/ws',
			my: 'server-1',
			to: 'raspi-1',
			command: 'start_session',
			mapped: 'start_session',
		});
		//doorClose();
		decompValve(0);
	}

	// Sistem aktifse kontrol et
	if (sessionStatus.status > 0 && sessionStatus.zaman > 5) {
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

		if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.profile[sessionStatus.zaman + 1] &&
			sessionStatus.profile[sessionStatus.zaman][2] == 'air' &&
			sessionStatus.profile[sessionStatus.zaman + 1][2] == 'o' &&
			sessionStatus.oksijen == 0
		) {
			sessionStatus.oksijen = 1;
			alarmSet('oxygenBreak', 'Oxygen Starting. Put the mask on.', 0);
			sendCommand({
				url: 'ws://192.168.77.100:8080/ws',
				my: 'server-1',
				to: 'raspi-1',
				command: 'puton_mask',
				mapped: 'puton_mask',
			});
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

			sendCommand({
				url: 'ws://192.168.77.100:8080/ws',
				my: 'server-1',
				to: 'raspi-1',
				command: 'deco_start',
				mapped: 'deco_start',
			});

			console.log(
				'Değişti : oksijen',
				sessionStatus.oksijen,
				'oksijenBaslangicZamani',
				sessionStatus.oksijenBaslangicZamani,
				'oksijenBitisZamani',
				sessionStatus.oksijenBitisZamani
			);
			oxygenClose();
		} else if (
			sessionStatus.profile[sessionStatus.zaman] &&
			sessionStatus.profile[sessionStatus.zaman + 1] &&
			sessionStatus.profile[sessionStatus.zaman][2] == 'o' &&
			sessionStatus.profile[sessionStatus.zaman + 1][2] == 'air' &&
			sessionStatus.oksijen == 1
		) {
			sessionStatus.oksijen = 0;

			alarmSet('oxygenBreak', 'Oxygen Stopped. Take the mask off.', 0);

			sendCommand({
				url: 'ws://192.168.77.100:8080/ws',
				my: 'server-1',
				to: 'raspi-1',
				command: 'takeoff_mask',
				mapped: 'takeoff_mask',
			});
		}
	} else {
		// Düz durumdan çıkıldığında timer'ları sıfırla
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
		if (sessionStatus.cikis == 1) {
			compValve(0);
			decompValve(90);
		}

		// Yüksek oksijen kontrolü
		if (sessionStatus.higho == 1 && sessionStatus.ventil != 1) {
			sessionStatus.ventil = 1;
			sessionStatus.vanacikis = 30;
			if (sessionStatus.ohava == 1) ohavad('a');
			//alarmSet('highO2', 'High O2 Level. Ventilation Started.', 0);
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
			(sessionStatus.zaman > sessionStatus.profile.length - 30 ||
				sessionStatus.cikis == 1) &&
			sessionStatus.eop == 0 &&
			sessionStatus.pressure < 0.01
		) {
			sessionStatus.eop = 1;
			alarmSet('endOfSession', 'Session Finished.', 0);
			sendCommand({
				url: 'ws://192.168.77.100:8080/ws',
				my: 'server-1',
				to: 'raspi-1',
				command: 'end_session',
				mapped: 'end_session',
			});
			sessionStartBit(0);
			//doorOpen();
			compValve(0);
			decompValve(90);
			sessionStatus.durum = 0;
			sessionStatus.uyariyenile = 1;
			sessionStatus.uyaridurum = 1;
			// Seans sonu varsayılanlarını doğrudan alanlara ata
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
			sessionStatus.pauseDepteh = 0;
			sessionStatus.doorSensorStatus = 0;
			sessionStatus.doorStatus = 0;
			sessionStatus.pressure = 0;
			sessionStatus.o2 = 0;
			sessionStatus.bufferdifference = [];
			sessionStatus.olcum = [];
			sessionStatus.ventil = 0;
			sessionStatus.vanacikis = 30;
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
		}
	}

	// Görüntüleme değeri hesapla
	var displayValue = sessionStatus.main_fsw;
	if (
		Math.abs(difference) < 2.5 &&
		Array.isArray(sessionStatus.profile) &&
		sessionStatus.profile[sessionStatus.zaman] &&
		Array.isArray(sessionStatus.profile[sessionStatus.zaman]) &&
		sessionStatus.profile[sessionStatus.zaman].length > 1
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
		// Simulate pressure based on profile (demo mode)zaxaza
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

		// Update session status with simulated data
		sessionStatus.pressure = sessionStatus.hedef / 33.4;
		sessionStatus.main_fsw = sessionStatus.hedef / 33.4;
		sensorData['pressure'] = filters.pressure.update(
			sessionStatus.hedef / 33.4
		);

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
		if (
			sessionStatus.grafikdurum === 2 &&
			sessionStatus.otomanuel == 0 &&
			sessionStatus.status == 1
		) {
			if (
				sessionStatus.oksijen == 0 &&
				sessionStatus.oksijenBaslangicZamani == 0 &&
				sessionStatus.oksijenBitisZamani == 0
			) {
				sessionStatus.oksijen = 1;
				sessionStatus.oksijenBaslangicZamani = sessionStatus.zaman + 1;
				sessionStatus.oksijenBitisZamani = sessionStatus.zaman + 1 * 60;
				alarmSet(
					'oxygenBreak',
					'Treatment Starting. Please put the mask on.',
					0
				);
				console.log(
					'Değişti : oksijen',
					sessionStatus.oksijen,
					'oksijenBaslangicZamani',
					sessionStatus.oksijenBaslangicZamani,
					'oksijenBitisZamani',
					sessionStatus.oksijenBitisZamani
				);
			} else if (
				sessionStatus.oksijen == 1 &&
				sessionStatus.zaman >= sessionStatus.oksijenBitisZamani
			) {
				console.log(
					'Değişti : oksijen',
					sessionStatus.oksijen,
					'oksijenBaslangicZamani',
					sessionStatus.oksijenBaslangicZamani,
					'oksijenBitisZamani',
					sessionStatus.oksijenBitisZamani
				);
				sessionStatus.oksijen = 0;
				sessionStatus.oksijenBaslangicZamani = sessionStatus.zaman + 1 * 60;
				sessionStatus.oksijenBitisZamani = 0;
				alarmSet(
					'oxygenBreak',
					'Please take off your mask. Oxygen Break Time.',
					0
				);
			} else if (
				sessionStatus.oksijen == 0 &&
				sessionStatus.zaman >= sessionStatus.oksijenBaslangicZamani &&
				sessionStatus.oksijenBitisZamani == 0
			) {
				sessionStatus.oksijen = 1;
				sessionStatus.oksijenBaslangicZamani = sessionStatus.zaman + 1;
				sessionStatus.oksijenBitisZamani = sessionStatus.zaman + 1 * 60;
				alarmSet('oxygenBreak', 'Please put the mask on.', 0);
				console.log(
					'Değişti : oksijen',
					sessionStatus.oksijen,
					'oksijenBaslangicZamani',
					sessionStatus.oksijenBaslangicZamani,
					'oksijenBitisZamani',
					sessionStatus.oksijenBitisZamani
				);
			}

			console.log(
				'oksijen',
				sessionStatus.oksijen,
				'oksijenBaslangicZamani',
				sessionStatus.oksijenBaslangicZamani,
				'oksijenBitisZamani',
				sessionStatus.oksijenBitisZamani
			);
		} else {
			// Düz durumdan çıkıldığında timer'ları sıfırla
			if (
				sessionStatus.lastdurum === 2 &&
				sessionStatus.cikis == 0 &&
				sessionStatus.grafikdurum == 0
			) {
				sessionStatus.oksijen = 0;
				sessionStatus.oksijenBaslangicZamani = 0;
				sessionStatus.oksijenBitisZamani = 0;
				alarmSet(
					'treatmenFinished',
					'Treatment Finished. Please take off your mask. Decompression Starting.',
					0
				);
				console.log(
					'Değişti : oksijen',
					sessionStatus.oksijen,
					'oksijenBaslangicZamani',
					sessionStatus.oksijenBaslangicZamani,
					'oksijenBitisZamani',
					sessionStatus.oksijenBitisZamani
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
				(sessionStatus.zaman > sessionStatus.profile.length - 10 ||
					sessionStatus.cikis == 1) &&
				sessionStatus.eop == 0 &&
				sessionStatus.main_fsw <= 0.5
			) {
				sessionStatus.eop = 1;
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
					cikis: 0,
					grafikdurum: 0,
					adim: 0,
					hedef: 0,
					lastdurum: 0,
					wait: 0,
					p2counter: 0,
					tempadim: 0,
					profile: [],
					minimumvalve: 12,
					otomanuel: 0,
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
					vanacikis: 30,
					main_fsw: 0,
					pcontrol: 0,
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
		console.log('');

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

	socket.emit('sensorData', {
		pressure: Number(sensorData['pressure'].toFixed(2)) || 0,
		o2: Number(sensorData['o2'].toFixed(0)) || 0,
		temperature: Number(sensorData['temperature'].toFixed(1)) || 0,
		humidity: Number(sensorData['humidity'].toFixed(0)) || 0,
		sessionStatus: sessionStatus,
		doorStatus: sessionStatus.doorStatus,
	});

	// Publish all chamber data to MQTT
	publishAllChamberData();
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

	// Publish alarm to MQTT
	const alarmPayload = {
		status: alarmStatus.status,
		type: alarmStatus.type,
		text: alarmStatus.text,
		time: alarmStatus.time ? dayjs(alarmStatus.time).toISOString() : null,
		duration: alarmStatus.duration,
	};
	publishToMQTT(`${MQTT_TOPIC_PREFIX}/alarm`, alarmPayload);
}

function alarmClear() {
	alarmStatus.status = 0;
	alarmStatus.type = '';
	alarmStatus.text = '';
	alarmStatus.time = 0;
	alarmStatus.duration = 0;
	sessionStatus.patientWarning = false;

	// Publish alarm clear to MQTT
	const alarmPayload = {
		status: alarmStatus.status,
		type: alarmStatus.type,
		text: alarmStatus.text,
		time: null,
		duration: alarmStatus.duration,
	};
	publishToMQTT(`${MQTT_TOPIC_PREFIX}/alarm`, alarmPayload);
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

function oxygenOpen() {
	console.log('Oxygen Opening');
	socket.emit('writeBit', { register: 'M0110', value: 1 });
}

function oxygenClose() {
	console.log('Oxygen Close');
	socket.emit('writeBit', { register: 'M0110', value: 0 });
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

/**
 * Manuel ventilasyon başlatma
 * @param {number} mode - Ventilasyon modu (1: düşük, 2: orta, 3: yüksek)
 * @param {number} intensity - Çıkış vanası açıklığı (0-90 derece, isteğe bağlı)
 */
function ventilationStart(mode = 1, intensity = null) {
	if (sessionStatus.status === 0) {
		console.log('Ventilasyon: Aktif seans yok, ventilasyon başlatılamaz.');
		return { success: false, message: 'No active session' };
	}

	// Mod kontrolü
	if (mode < 1 || mode > 3) {
		mode = 1;
	}

	// Varsayılan şiddet değerleri
	const defaultIntensities = {
		1: 20, // Düşük
		2: 35, // Orta
		3: 50, // Yüksek
	};

	// Şiddet değeri belirtilmemişse mod'a göre varsayılan kullan
	const finalIntensity =
		intensity !== null
			? Math.min(90, Math.max(0, intensity))
			: defaultIntensities[mode];

	sessionStatus.ventil = mode;
	sessionStatus.vanacikis = finalIntensity;

	console.log(
		`Ventilasyon başlatıldı - Mod: ${mode}, Şiddet: ${finalIntensity}°`
	);

	return {
		success: true,
		mode: mode,
		intensity: finalIntensity,
		message: `Ventilation started - Mode: ${mode}, Intensity: ${finalIntensity}°`,
	};
}

/**
 * Manuel ventilasyon durdurma
 */
function ventilationStop() {
	sessionStatus.ventil = 0;
	console.log('Ventilasyon durduruldu');

	// Vanaları kapat
	compValve(0);
	decompValve(0);

	return {
		success: true,
		message: 'Ventilation stopped',
	};
}

/**
 * Ventilasyon şiddetini ayarla (çalışırken değiştirmek için)
 * @param {number} intensity - Çıkış vanası açıklığı (0-90 derece)
 */
function ventilationSetIntensity(intensity) {
	if (sessionStatus.ventil === 0) {
		console.log('Ventilasyon: Ventilasyon aktif değil.');
		return { success: false, message: 'Ventilation is not active' };
	}

	const finalIntensity = Math.min(90, Math.max(0, intensity));
	sessionStatus.vanacikis = finalIntensity;

	console.log(`Ventilasyon şiddeti ayarlandı: ${finalIntensity}°`);

	return {
		success: true,
		intensity: finalIntensity,
		message: `Ventilation intensity set to ${finalIntensity}°`,
	};
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
	const depthDifference = nextDepth - currentPressure;

	// Tüm profiller saniye bazlı ve basınç her saniye eğriye göre değişmeli
	// Bu nedenle pause aralığını saniye saniye sabit basınçla dolduruyoruz
	// ardından mevcut adımın hedef basıncına saniye saniye interpolasyonla geri dönüyoruz

	// Geçerli adım numarası (1-based). Yoksa mümkünse bir önceki saniyeden al
	let stepIndexVal =
		(currentStep && currentStep.length >= 4 && currentStep[3]) ||
		(pauseStartTime > 0 && sessionStatus.profile[pauseStartTime - 1]
			? sessionStatus.profile[pauseStartTime - 1][3]
			: 1);

	// Orijinal hedef basıncı belirle (adımın hedefi)
	let originalTargetDepth = currentStep[1];
	if (
		Array.isArray(sessionStatus.profileSteps) &&
		sessionStatus.profileSteps[stepIndexVal - 1]
	) {
		originalTargetDepth = sessionStatus.profileSteps[stepIndexVal - 1][1];
	} else {
		// profileSteps yoksa, aynı adım numarası devam ettiği son saniyenin basıncını kullan
		let t = pauseStartTime;
		let lastInStep = t;
		while (
			t + 1 < sessionStatus.profile.length &&
			Array.isArray(sessionStatus.profile[t + 1]) &&
			sessionStatus.profile[t + 1].length >= 4 &&
			sessionStatus.profile[t + 1][3] === stepIndexVal
		) {
			t++;
			lastInStep = t;
		}
		if (sessionStatus.profile[lastInStep]) {
			originalTargetDepth = sessionStatus.profile[lastInStep][1];
		}
	}

	// Pause aralığını sabit basınçla güncelle
	for (
		let t = pauseStartTime;
		t < pauseEndTime && t < sessionStatus.profile.length;
		t++
	) {
		const existing = sessionStatus.profile[t] || [];
		const existingType = existing[2] || 'air';
		const existingStep = (existing.length >= 4 && existing[3]) || stepIndexVal;
		// [zaman(s), basınç, tip, adım]
		sessionStatus.profile[t] = [
			// zaman sütunu dizin+1 olacak şekilde tutulur
			t + 1,
			Number(currentPressure.toFixed(4)),
			'air',
			existingStep,
		];
	}

	// Bir önceki eğimin büyüklüğünü saniye başına hesapla
	let slope = 0;
	if (pauseStartTime > 0) {
		const prevP = sessionStatus.profile[pauseStartTime - 1]
			? sessionStatus.profile[pauseStartTime - 1][1]
			: currentPressure;
		const currP = currentStep[1];
		slope = Math.abs(currP - prevP);
	}
	if (slope === 0) {
		// İleri farkı dene
		const nextP = nextStep[1];
		slope = Math.abs(nextP - currentStep[1]);
	}

	const remainingDepthChange = originalTargetDepth - currentPressure;
	const absSlope = Math.abs(slope);
	let timeToTarget =
		absSlope > 0 ? Math.ceil(Math.abs(remainingDepthChange) / absSlope) : 0;
	if (timeToTarget < 0 || !isFinite(timeToTarget)) timeToTarget = 0;

	// Profil uzunluğu içinde kal
	const maxAvailable = Math.max(0, sessionStatus.profile.length - pauseEndTime);
	timeToTarget = Math.min(timeToTarget, maxAvailable);

	// Hedefe geri dönmek için saniye saniye interpolasyon uygula
	for (let s = 1; s <= timeToTarget; s++) {
		const idx = pauseEndTime + (s - 1);
		if (idx >= sessionStatus.profile.length) break;
		const ratio = timeToTarget > 0 ? s / timeToTarget : 1;
		const interp = currentPressure + remainingDepthChange * ratio;
		const existing = sessionStatus.profile[idx] || [];
		const type =
			Array.isArray(sessionStatus.profileSteps) &&
			sessionStatus.profileSteps[stepIndexVal - 1]
				? sessionStatus.profileSteps[stepIndexVal - 1][2]
				: existing[2] || 'air';
		sessionStatus.profile[idx] = [
			idx + 1,
			Number(interp.toFixed(4)),
			type,
			stepIndexVal,
		];
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

	// Adjust total duration (in minutes) to match the truncated profile
	if (Array.isArray(sessionStatus.profile)) {
		const totalSeconds = sessionStatus.profile.length;
		const totalMinutes = Math.round(totalSeconds / 60);
		sessionStatus.toplamSure = Number.isFinite(totalMinutes)
			? totalMinutes
			: sessionStatus.toplamSure;
	}

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

	// Seans kaydını tamamla
	completeSessionRecord('stopped');
}

// function sessionStop() {
// 	console.log('Session stop initiated at time:', sessionStatus.zaman);

// 	// Set exit mode (equivalent to cikis=3 in PHP)
// 	compValve(0);
// 	decompValve(40);
// 	oxygenClose();
// 	sessionStatus.cikis = 3;
// 	sessionStatus.status = 3;
// 	sessionStatus.otomanuel = 0;
// 	sessionStatus.grafikdurum = 0;
// 	sessionStatus.oksijen = 0;
// 	sessionStatus.oksijenBaslangicZamani = 0;
// 	sessionStatus.oksijenBitisZamani = 0;

// 	// Convert profile to hedeflenen array format (depth values only)

// 	// Set exit flag for valve control
// 	sessionStatus.cikis = 1;

// 	alarmSet(
// 		'sessionStop',
// 		'Session stop initiated. Decompressing to surface.',
// 		0
// 	);
// }

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

const quickProfile = ProfileUtils.createQuickProfile([
	[sessionStatus.dalisSuresi, sessionStatus.setDerinlik, 'air'],
	[
		sessionStatus.toplamSure -
			(sessionStatus.dalisSuresi + sessionStatus.cikisSuresi),
		sessionStatus.setDerinlik,
		'air',
	],
	[sessionStatus.cikisSuresi, 0, 'air'],
]);
sessionStatus.profile = quickProfile.toTimeBasedArrayBySeconds();

// ============================================================================
// O2 KALİBRASYON FONKSİYONLARI
// ============================================================================

function setO2CalibrationPoint(point, rawValue, actualPercentage) {
	o2CalibrationData.point0.raw = 0;
	o2CalibrationData.point0.percentage = 0;

	o2CalibrationData.point21.raw = rawValue;
	o2CalibrationData.point21.percentage = 21;

	o2CalibrationData.point100.raw = (rawValue / 21) * 100;
	o2CalibrationData.point100.percentage = 100;

	console.log(`O2 Kalibrasyon Noktası %${point} ayarlandı:`, {
		raw: rawValue,
		percentage: actualPercentage,
	});

	// Re-initialize the O2 sensor with updated calibration data
	initializeO2Sensor();
}

// O2 sensor instance is now initialized at startup via initializeO2Sensor()

// setInterval(async () => {
// 	try {
// 		const connection = await checkInternetConnection();
// 		//console.log(connection);
// 		if (connection.isConnected) {
// 			console.log('Internet bağlantısı var.');
// 			const health = await checkSystemHealth('HC-001');
// 			console.log(health);
// 		} else {
// 			console.log('Internet bağlantısı yok.');
// 		}
// 	} catch (error) {
// 		console.log(error);
// 	}
// }, 10000);

/**
 * Creates alternating oxygen and air break segments for treatment phase
 * @param {number} treatmentDuration - Total treatment duration in minutes
 * @param {number} depth - Treatment depth
 * @returns {Array} Array of profile segments [duration, depth, gas_type]
 */
function createAlternatingTreatmentProfile(treatmentDuration, depth) {
	// Guard against invalid/negative durations
	if (typeof treatmentDuration !== 'number' || treatmentDuration <= 0) {
		return [];
	}

	const segments = [];
	const oxygenDuration = 20; // 15 minutes oxygen
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
	if (sessionStatus.toplamSure == 80 && sessionStatus.setDerinlik == 0.5 && sessionStatus.speed == 2) {
					treatmentSegments = [
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
						[5, sessionStatus.setDerinlik, 'air'],
						[20, sessionStatus.setDerinlik, 'o'],
					];
				}
				else if (sessionStatus.toplamSure == 80) {
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

// ============================================================================
// SESSION RECORDING FUNCTIONS
// ============================================================================

/**
 * Yeni seans kaydı oluşturur
 * @param {Object} sessionData - Seans bilgileri
 * @returns {Promise<number|null>} - Oluşturulan kayıt ID'si veya null
 */
async function createSessionRecord(sessionData) {
	try {
		const record = await db.sessionRecords.create({
			startedAt: new Date(),
			targetDepth: sessionData.setDerinlik || sessionStatus.setDerinlik,
			speed: sessionData.speed || sessionStatus.speed || 1,
			totalDuration: sessionData.toplamSure || sessionStatus.toplamSure,
			descDuration: sessionStatus.dalisSuresi || 0,
			ascDuration: sessionStatus.cikisSuresi || 0,
			status: 'started',
			startedByUserId: currentLoggedInUserId,
		});
		console.log('Session record created:', record.id);
		currentSessionRecordId = record.id;
		return record.id;
	} catch (error) {
		console.error('Error creating session record:', error);
		return null;
	}
}

/**
 * Sensör verilerini loglar (her saniye çağrılmalı)
 */
async function logSessionSensorData() {
	if (!currentSessionRecordId || sessionStatus.status !== 1) {
		return;
	}

	try {
		// Profilden hedef basıncı al
		let targetPressure = 0;
		if (Array.isArray(sessionStatus.profile) && sessionStatus.profile[sessionStatus.zaman]) {
			targetPressure = sessionStatus.profile[sessionStatus.zaman][1] || 0;
		}

		await db.sessionSensorLogs.create({
			sessionRecordId: currentSessionRecordId,
			timestamp: new Date(),
			sessionTime: sessionStatus.zaman || 0,
			pressure: sensorData['pressure'] || 0,
			targetPressure: targetPressure,
			isManualMode: sessionStatus.otomanuel === 1,
			o2: sensorData['o2'] || 0,
			temperature: sensorData['temperature'] || 0,
			humidity: sensorData['humidity'] || 0,
		});
	} catch (error) {
		console.error('Error logging sensor data:', error);
	}
}

/**
 * Seans kaydını tamamlar
 * @param {string} status - Seans durumu: 'completed' veya 'stopped'
 */
async function completeSessionRecord(status = 'completed') {
	if (!currentSessionRecordId) {
		return;
	}

	try {
		await db.sessionRecords.update(
			{
				endedAt: new Date(),
				status: status,
			},
			{
				where: { id: currentSessionRecordId },
			}
		);
		console.log('Session record completed:', currentSessionRecordId, 'Status:', status);
		currentSessionRecordId = null;
	} catch (error) {
		console.error('Error completing session record:', error);
	}
}

/**
 * Kullanıcı giriş yaptığında çağrılır
 * @param {number} userId - Giriş yapan kullanıcı ID'si
 */
function setLoggedInUser(userId) {
	currentLoggedInUserId = userId;
	console.log('Logged in user set:', userId);
}

// Global olarak erişilebilir yap
global.setLoggedInUser = setLoggedInUser;
global.currentLoggedInUserId = currentLoggedInUserId;
