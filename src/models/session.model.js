module.exports = (sequelize, DataTypes) => {
	const Session = sequelize.define('Session', {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},
		startTime: {
			type: DataTypes.DATE,
			allowNull: false,
		},
		endTime: {
			type: DataTypes.DATE,
			allowNull: true, // null = devam ediyor (veya elektrik kesintisi)
		},
		status: {
			type: DataTypes.STRING,
			allowNull: false,
			defaultValue: 'running', // running, completed, stopped, interrupted
			validate: { isIn: [['running', 'completed', 'stopped', 'interrupted']] },
		},
		targetPressure: {
			type: DataTypes.FLOAT, // bar
			allowNull: true,
		},
		duration: {
			type: DataTypes.INTEGER, // planlanan toplam süre (dk)
			allowNull: true,
		},
		speed: {
			type: DataTypes.INTEGER, // 1/2/3
			allowNull: true,
		},
		// Planlanan hedef grafik [[t, bar], ...] — 10 sn'e seyreltilmiş
		profile: {
			type: DataTypes.TEXT,
			allowNull: true,
			get() {
				const value = this.getDataValue('profile');
				if (!value || value === 'null') return [];
				return JSON.parse(value);
			},
			set(value) {
				this.setDataValue('profile', JSON.stringify(value));
			},
		},
		// Örnekler [[t, hedefBar, basınçBar, sıcaklık, nem, o2], ...] — 10 sn aralıklı
		samples: {
			type: DataTypes.TEXT,
			allowNull: true,
			get() {
				const value = this.getDataValue('samples');
				if (!value || value === 'null') return [];
				return JSON.parse(value);
			},
			set(value) {
				this.setDataValue('samples', JSON.stringify(value));
			},
		},
		// Olaylar [{type:'pause'|'resume'|'stop'|'complete', t, reason?}, ...]
		events: {
			type: DataTypes.TEXT,
			allowNull: true,
			get() {
				const value = this.getDataValue('events');
				if (!value || value === 'null') return [];
				return JSON.parse(value);
			},
			set(value) {
				this.setDataValue('events', JSON.stringify(value));
			},
		},
	});

	return Session;
};
