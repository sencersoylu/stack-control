const express = require('express');
const router = express.Router();
const db = require('../models/index');
const { errorResponse, successResponse } = require('../helpers/index');

// Tüm sensörleri listele
router.get('/sensors/list', async (req, res) => {
	try {
		const sensors = await db.sensors.findAll();
		successResponse(req, res, sensors);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Tek bir sensörü getir
router.get('/sensors/:id', async (req, res) => {
	try {
		const sensor = await db.sensors.findByPk(req.params.id);
		if (!sensor) {
			return errorResponse(req, res, { message: 'Sensor not found' });
		}
		successResponse(req, res, sensor);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Sensör güncelle
router.put('/sensors/:id', async (req, res) => {
	try {
		const sensor = await db.sensors.findByPk(req.params.id);
		if (!sensor) {
			return errorResponse(req, res, { message: 'Sensor not found' });
		}
		
		const {
			sensorName, sensorText, sensorMemory, sensorSymbol,
			sensorOffset, sensorLowerLimit, sensorUpperLimit,
			sensorAnalogUpper, sensorAnalogLower, sensorDecimal
		} = req.body;
		
		await sensor.update({
			sensorName: sensorName !== undefined ? sensorName : sensor.sensorName,
			sensorText: sensorText !== undefined ? sensorText : sensor.sensorText,
			sensorMemory: sensorMemory !== undefined ? sensorMemory : sensor.sensorMemory,
			sensorSymbol: sensorSymbol !== undefined ? sensorSymbol : sensor.sensorSymbol,
			sensorOffset: sensorOffset !== undefined ? sensorOffset : sensor.sensorOffset,
			sensorLowerLimit: sensorLowerLimit !== undefined ? sensorLowerLimit : sensor.sensorLowerLimit,
			sensorUpperLimit: sensorUpperLimit !== undefined ? sensorUpperLimit : sensor.sensorUpperLimit,
			sensorAnalogUpper: sensorAnalogUpper !== undefined ? sensorAnalogUpper : sensor.sensorAnalogUpper,
			sensorAnalogLower: sensorAnalogLower !== undefined ? sensorAnalogLower : sensor.sensorAnalogLower,
			sensorDecimal: sensorDecimal !== undefined ? sensorDecimal : sensor.sensorDecimal,
		});
		
		// Global sensor calibration data'yı güncelle
		if (global.sensorCalibrationData && sensor.sensorName) {
			global.sensorCalibrationData[sensor.sensorName] = {
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
		}
		
		successResponse(req, res, sensor);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Yeni sensör ekle
router.post('/sensors', async (req, res) => {
	try {
		const {
			sensorName, sensorText, sensorMemory, sensorSymbol,
			sensorOffset, sensorLowerLimit, sensorUpperLimit,
			sensorAnalogUpper, sensorAnalogLower, sensorDecimal
		} = req.body;
		
		const sensor = await db.sensors.create({
			sensorName,
			sensorText,
			sensorMemory,
			sensorSymbol,
			sensorOffset: sensorOffset || 0,
			sensorLowerLimit: sensorLowerLimit || 0,
			sensorUpperLimit: sensorUpperLimit || 100,
			sensorAnalogUpper: sensorAnalogUpper || 16383,
			sensorAnalogLower: sensorAnalogLower || 0,
			sensorDecimal: sensorDecimal || 2,
		});
		
		successResponse(req, res, sensor);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Sensör sil
router.delete('/sensors/:id', async (req, res) => {
	try {
		const sensor = await db.sensors.findByPk(req.params.id);
		if (!sensor) {
			return errorResponse(req, res, { message: 'Sensor not found' });
		}
		
		await sensor.destroy();
		successResponse(req, res, { message: 'Sensor deleted successfully' });
	} catch (error) {
		errorResponse(req, res, error);
	}
});

// Tüm sensörleri toplu güncelle
router.post('/sensors/bulk-update', async (req, res) => {
	try {
		const { sensors } = req.body;
		
		if (!Array.isArray(sensors)) {
			return errorResponse(req, res, { message: 'Sensors array is required' });
		}
		
		const results = [];
		for (const sensorData of sensors) {
			if (sensorData.sensorID) {
				const sensor = await db.sensors.findByPk(sensorData.sensorID);
				if (sensor) {
					await sensor.update(sensorData);
					results.push(sensor);
				}
			}
		}
		
		successResponse(req, res, results);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

module.exports = router;
