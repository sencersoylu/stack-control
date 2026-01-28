module.exports = (sequelize, DataTypes) => {
	const TuningSession = sequelize.define('TuningSession', {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},
		// Seans bilgileri
		sessionStartTime: {
			type: DataTypes.DATE,
			allowNull: false,
		},
		sessionEndTime: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		status: {
			type: DataTypes.STRING,
			defaultValue: 'collecting', // collecting, analyzing, completed
		},
		// Hedef parametreler
		targetDepth: {
			type: DataTypes.FLOAT,
			allowNull: true,
		},
		targetDuration: {
			type: DataTypes.INTEGER,
			allowNull: true,
		},
		// Kullanilan parametreler
		usedCompOffset: {
			type: DataTypes.FLOAT,
			allowNull: true,
		},
		usedCompGain: {
			type: DataTypes.FLOAT,
			allowNull: true,
		},
		usedCompDepth: {
			type: DataTypes.FLOAT,
			allowNull: true,
		},
		usedDecompOffset: {
			type: DataTypes.FLOAT,
			allowNull: true,
		},
		usedDecompGain: {
			type: DataTypes.FLOAT,
			allowNull: true,
		},
		usedDecompDepth: {
			type: DataTypes.FLOAT,
			allowNull: true,
		},
		// Toplanan veri (JSON olarak)
		collectedData: {
			type: DataTypes.TEXT,
			allowNull: true,
			get() {
				const value = this.getDataValue('collectedData');
				return value ? JSON.parse(value) : [];
			},
			set(value) {
				this.setDataValue('collectedData', JSON.stringify(value));
			},
		},
		// Analiz sonuclari
		analysisResults: {
			type: DataTypes.TEXT,
			allowNull: true,
			get() {
				const value = this.getDataValue('analysisResults');
				return value ? JSON.parse(value) : null;
			},
			set(value) {
				this.setDataValue('analysisResults', JSON.stringify(value));
			},
		},
		// Onerilen parametreler
		suggestedParams: {
			type: DataTypes.TEXT,
			allowNull: true,
			get() {
				const value = this.getDataValue('suggestedParams');
				return value ? JSON.parse(value) : null;
			},
			set(value) {
				this.setDataValue('suggestedParams', JSON.stringify(value));
			},
		},
		// Onay durumu
		approved: {
			type: DataTypes.BOOLEAN,
			defaultValue: false,
		},
		approvedAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
	});

	return TuningSession;
};
