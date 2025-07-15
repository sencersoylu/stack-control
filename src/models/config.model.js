module.exports = (sequelize, Sequelize) => {
	const config = sequelize.define(
		'config',
		{
			projectName: Sequelize.STRING,
			chamberType: Sequelize.STRING,
			pressureLimit: Sequelize.INTEGER,
			sessionCounterLimit: Sequelize.INTEGER,
			sessionTimeLimit: Sequelize.INTEGER,
			o2SensorLastCalibration: Sequelize.DATE,
			o2SensorLastChange: Sequelize.DATE,
			o2GeneratorLastMaintenance: Sequelize.DATE,
			chamberLastMaintenance: Sequelize.DATE,
			sessionCounter: Sequelize.INTEGER,
			installationDate: Sequelize.DATE,
			lastSessionDate: Sequelize.DATE,
			

		},
		{}
	);

	return config;
};
