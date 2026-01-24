const express = require('express');
const router = express.Router();
const db = require('../models/index');
const { errorResponse, successResponse } = require('../helpers/index');

// Varsayılan config değerleri
const defaultConfigValues = {
	projectName: 'Stack Control',
	chamberType: 'Hyperbaric Chamber',
	pressureLimit: 3,
	sessionCounterLimit: 1000,
	sessionTimeLimit: 120,
	sessionCounter: 0,
	
	// O2 Kalibrasyon verileri
	o2Point0Raw: 0,
	o2Point0Percentage: 0,
	o2Point21Raw: 860,
	o2Point21Percentage: 21,
	o2Point100Raw: 4600,
	o2Point100Percentage: 100,
	o2AlarmValuePercentage: 23.5,
	o2AlarmOn: false,
	
	// Filter alpha değerleri
	filterAlphaPressure: 0.35,
	filterAlphaO2: 0.2,
	filterAlphaTemperature: 0.25,
	filterAlphaHumidity: 0.25,
	filterAlphaCo2: 0.3,
	
	// Kompresör kontrol parametreleri
	compOffset: 12,
	compGain: 8,
	compDepth: 100,
	
	// Dekompresyon kontrol parametreleri
	decompOffset: 25,
	decompGain: 7,
	decompDepth: 100,
	
	// Vana ayarları
	minimumValve: 5,
	
	// Varsayılan seans parametreleri
	defaultDalisSuresi: 10,
	defaultCikisSuresi: 10,
	defaultToplamSure: 60,
	defaultSetDerinlik: 1,
	defaultSpeed: 1,
	
	// Alarm seviyeleri
	humidityAlarmLevel: 70,
	highO2Level: 23,
	
	// Oksijen molası ayarları
	oxygenDuration: 15,
	airBreakDuration: 5,
	
	// Demo modu
	demoMode: false,
	
	// PLC bağlantı ayarları
	plcIpAddress: '192.168.77.100',
	plcPort: 4000,
};

// Config'i al
router.get('/getConfig', async (req, res) => {
	try {
		let config = await db.config.findOne({ where: { id: 1 } });
		
		// Eğer config yoksa varsayılan değerlerle oluştur
		if (!config) {
			config = await db.config.create(defaultConfigValues);
		}
		
		successResponse(req, res, config);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Config'i güncelle
router.post('/updateConfig', async (req, res) => {
	try {
		let config = await db.config.findOne({ where: { id: 1 } });
		
		if (!config) {
			// Eğer config yoksa yeni oluştur
			config = await db.config.create({
				...defaultConfigValues,
				...req.body
			});
		} else {
			// Mevcut config'i güncelle
			await config.update(req.body);
		}
		
		// Global config'i güncelle (eğer global.appConfig varsa)
		if (global.appConfig) {
			Object.assign(global.appConfig, config.toJSON());
		}
		
		successResponse(req, res, config);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Config'i sıfırla (varsayılan değerlere döndür)
router.post('/resetConfig', async (req, res) => {
	try {
		let config = await db.config.findOne({ where: { id: 1 } });
		
		if (config) {
			await config.update(defaultConfigValues);
		} else {
			config = await db.config.create(defaultConfigValues);
		}
		
		// Global config'i güncelle
		if (global.appConfig) {
			Object.assign(global.appConfig, config.toJSON());
		}
		
		successResponse(req, res, config);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Belirli bir config alanını güncelle
router.patch('/updateConfigField', async (req, res) => {
	try {
		const { field, value } = req.body;
		
		if (!field) {
			return errorResponse(req, res, { message: 'Field name is required' });
		}
		
		let config = await db.config.findOne({ where: { id: 1 } });
		
		if (!config) {
			config = await db.config.create(defaultConfigValues);
		}
		
		// Sadece belirtilen alanı güncelle
		await config.update({ [field]: value });
		
		// Global config'i güncelle
		if (global.appConfig) {
			global.appConfig[field] = value;
		}
		
		successResponse(req, res, config);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// O2 kalibrasyon verilerini güncelle
router.post('/updateO2Calibration', async (req, res) => {
	try {
		const { point0, point21, point100, alarmValue, alarmOn } = req.body;
		
		let config = await db.config.findOne({ where: { id: 1 } });
		
		if (!config) {
			config = await db.config.create(defaultConfigValues);
		}
		
		const updateData = {
			o2CalibrationDate: new Date()
		};
		
		if (point0) {
			updateData.o2Point0Raw = point0.raw;
			updateData.o2Point0Percentage = point0.percentage;
		}
		if (point21) {
			updateData.o2Point21Raw = point21.raw;
			updateData.o2Point21Percentage = point21.percentage;
		}
		if (point100) {
			updateData.o2Point100Raw = point100.raw;
			updateData.o2Point100Percentage = point100.percentage;
		}
		if (alarmValue !== undefined) {
			updateData.o2AlarmValuePercentage = alarmValue;
		}
		if (alarmOn !== undefined) {
			updateData.o2AlarmOn = alarmOn;
		}
		
		await config.update(updateData);
		
		// Global config'i güncelle
		if (global.appConfig) {
			Object.assign(global.appConfig, updateData);
		}
		
		successResponse(req, res, config);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Kontrol parametrelerini güncelle (comp/decomp)
router.post('/updateControlParams', async (req, res) => {
	try {
		const {
			compOffset, compGain, compDepth,
			decompOffset, decompGain, decompDepth,
			minimumValve
		} = req.body;
		
		let config = await db.config.findOne({ where: { id: 1 } });
		
		if (!config) {
			config = await db.config.create(defaultConfigValues);
		}
		
		const updateData = {};
		
		if (compOffset !== undefined) updateData.compOffset = compOffset;
		if (compGain !== undefined) updateData.compGain = compGain;
		if (compDepth !== undefined) updateData.compDepth = compDepth;
		if (decompOffset !== undefined) updateData.decompOffset = decompOffset;
		if (decompGain !== undefined) updateData.decompGain = decompGain;
		if (decompDepth !== undefined) updateData.decompDepth = decompDepth;
		if (minimumValve !== undefined) updateData.minimumValve = minimumValve;
		
		await config.update(updateData);
		
		// Global config'i güncelle
		if (global.appConfig) {
			Object.assign(global.appConfig, updateData);
		}
		
		successResponse(req, res, config);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Varsayılan seans parametrelerini güncelle
router.post('/updateDefaultSessionParams', async (req, res) => {
	try {
		const {
			defaultDalisSuresi, defaultCikisSuresi,
			defaultToplamSure, defaultSetDerinlik, defaultSpeed
		} = req.body;
		
		let config = await db.config.findOne({ where: { id: 1 } });
		
		if (!config) {
			config = await db.config.create(defaultConfigValues);
		}
		
		const updateData = {};
		
		if (defaultDalisSuresi !== undefined) updateData.defaultDalisSuresi = defaultDalisSuresi;
		if (defaultCikisSuresi !== undefined) updateData.defaultCikisSuresi = defaultCikisSuresi;
		if (defaultToplamSure !== undefined) updateData.defaultToplamSure = defaultToplamSure;
		if (defaultSetDerinlik !== undefined) updateData.defaultSetDerinlik = defaultSetDerinlik;
		if (defaultSpeed !== undefined) updateData.defaultSpeed = defaultSpeed;
		
		await config.update(updateData);
		
		// Global config'i güncelle
		if (global.appConfig) {
			Object.assign(global.appConfig, updateData);
		}
		
		successResponse(req, res, config);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

module.exports = router;
