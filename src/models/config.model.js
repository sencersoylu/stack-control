module.exports = (sequelize, Sequelize) => {
	const config = sequelize.define(
		'config',
		{
			// Proje ve cihaz bilgileri
			projectName: Sequelize.STRING,
			chamberType: Sequelize.STRING,

			// Basınç ve seans limitleri
			pressureLimit: Sequelize.INTEGER,
			sessionCounterLimit: Sequelize.INTEGER,
			sessionTimeLimit: Sequelize.INTEGER,

			// Bakım ve kalibrasyon tarihleri
			o2SensorLastCalibration: Sequelize.DATE,
			o2SensorLastChange: Sequelize.DATE,
			o2GeneratorLastMaintenance: Sequelize.DATE,
			chamberLastMaintenance: Sequelize.DATE,

			// Seans sayacı ve tarihler
			sessionCounter: Sequelize.INTEGER,
			installationDate: Sequelize.DATE,
			lastSessionDate: Sequelize.DATE,

			// O2 Kalibrasyon verileri
			o2Point0Raw: { type: Sequelize.INTEGER, defaultValue: 0 },
			o2Point0Percentage: { type: Sequelize.FLOAT, defaultValue: 0 },
			o2Point21Raw: { type: Sequelize.INTEGER, defaultValue: 860 },
			o2Point21Percentage: { type: Sequelize.FLOAT, defaultValue: 21 },
			o2Point100Raw: { type: Sequelize.INTEGER, defaultValue: 4600 },
			o2Point100Percentage: { type: Sequelize.FLOAT, defaultValue: 100 },
			o2CalibrationDate: Sequelize.DATE,
			o2AlarmValuePercentage: { type: Sequelize.FLOAT, defaultValue: 23.5 },
			o2AlarmOn: { type: Sequelize.BOOLEAN, defaultValue: false },

			// Filter alpha değerleri
			filterAlphaPressure: { type: Sequelize.FLOAT, defaultValue: 0.35 },
			filterAlphaO2: { type: Sequelize.FLOAT, defaultValue: 0.2 },
			filterAlphaTemperature: { type: Sequelize.FLOAT, defaultValue: 0.25 },
			filterAlphaHumidity: { type: Sequelize.FLOAT, defaultValue: 0.25 },
			filterAlphaCo2: { type: Sequelize.FLOAT, defaultValue: 0.3 },

			// Kompresör kontrol parametreleri
			compOffset: { type: Sequelize.FLOAT, defaultValue: 12 },
			compGain: { type: Sequelize.FLOAT, defaultValue: 8 },
			compDepth: { type: Sequelize.FLOAT, defaultValue: 100 },

			// Dekompresyon kontrol parametreleri
			decompOffset: { type: Sequelize.FLOAT, defaultValue: 25 },
			decompGain: { type: Sequelize.FLOAT, defaultValue: 7 },
			decompDepth: { type: Sequelize.FLOAT, defaultValue: 100 },

			// Vana ayarları
			minimumValve: { type: Sequelize.INTEGER, defaultValue: 5 },
			compressionValveAnalog: { type: Sequelize.INTEGER, defaultValue: 9000 },
			decompressionValveAnalog: { type: Sequelize.INTEGER, defaultValue: 3500 },

			// Varsayılan seans parametreleri
			defaultDalisSuresi: { type: Sequelize.INTEGER, defaultValue: 10 },
			defaultCikisSuresi: { type: Sequelize.INTEGER, defaultValue: 10 },
			defaultToplamSure: { type: Sequelize.INTEGER, defaultValue: 60 },
			defaultSetDerinlik: { type: Sequelize.FLOAT, defaultValue: 1 },
			defaultSpeed: { type: Sequelize.INTEGER, defaultValue: 1 },

			// Alarm seviyeleri
			humidityAlarmLevel: { type: Sequelize.FLOAT, defaultValue: 70 },
			highO2Level: { type: Sequelize.FLOAT, defaultValue: 23 },

			// Oksijen molası ayarları
			oxygenDuration: { type: Sequelize.INTEGER, defaultValue: 15 },
			airBreakDuration: { type: Sequelize.INTEGER, defaultValue: 5 },

			// Demo modu
			demoMode: { type: Sequelize.BOOLEAN, defaultValue: false },

			// PLC bağlantı ayarları
			plcIpAddress: { type: Sequelize.STRING, defaultValue: '192.168.77.100' },
			plcPort: { type: Sequelize.INTEGER, defaultValue: 4000 },
		},
		{},
	);

	return config;
};
