const express = require('express');
const db = require('../models');
const exporter = require('highcharts-export-server');
const dayjs = require('dayjs');

const router = express.Router();

// Initialize exporter with proper configuration
let exporterInitialized = false;

async function initializeExporter() {
	if (!exporterInitialized) {
		try {
			const options = {
				pool: {
					minWorkers: 1,
					maxWorkers: 2,
				},
				puppeteer: {
					args: [
						'--no-sandbox',
						'--disable-setuid-sandbox',
						'--disable-dev-shm-usage',
						'--disable-accelerated-2d-canvas',
						'--no-first-run',
						'--no-zygote',
						'--disable-gpu',
					],
				},
			};

			await exporter.initPool(options);
			exporterInitialized = true;
			console.log('Highcharts exporter initialized successfully');
		} catch (error) {
			console.error('Failed to initialize exporter:', error);
			throw error;
		}
	}
}

router.use([require('./sensors.js')]);

// Get session chart
router.get('/getChart', async (req, res) => {
	try {
		// Check if we have session profile data
		if (!global.sessionStatus || !global.sessionStatus.profile) {
			return res
				.status(400)
				.json({ error: 'No session profile data available' });
		}

		const profile = global.sessionStatus.profile;

		// Convert profile data to pressure points with timestamps
		let currentTime = new Date();
		const pressureData = [];
		const plotBands = [];
		const olcumData = [];

		let timeOffset = 0; // minutes offset from start

		if (profile.length > 0) {
			profile.forEach((segment, index) => {
				const [duration, pressure, gasType] = segment;

				const time = global.sessionStatus.sessionStartTime.add(
					duration,
					'second'
				);

				if (global.sessionStatus.olcum.length > duration) {
					olcumData.push([
						time,
						Number(global.sessionStatus.olcum[index].toFixed(4)),
					]);
				}

				pressureData.push([time, pressure]); // Convert bar to psi (fsw approximation)

				// Add end point for this segment

				// Create plotBand for gas type
				// if (gasType === 'o2') {
				// 	plotBands.push({
				// 		from: startTime.getTime(),
				// 		to: endTime.getTime(),
				// 		color: '#b5e48c', // Green for oxygen
				// 	});
				// } else if (gasType === 'air') {
				// 	plotBands.push({
				// 		from: startTime.getTime(),
				// 		to: endTime.getTime(),
				// 		color: '#e0e0e0', // Light gray for air
				// 	});
				// }

				// timeOffset += duration;
			});
		} else {
			pressureData.push([0, 0]);
			olcumData.push([0, 0]);
		}

		const options = {
			puppeteer: {
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-accelerated-2d-canvas',
					'--no-first-run',
					'--no-zygote',
					'--disable-gpu',
				],
			},
			export: {
				type: 'png',
				width: 1200,
				height: 300,
				options: {
					chart: {
						backgroundColor: 'rgba(0,0,0,0)',
						zoomType: 'x',
						type: 'line',
					},
					title: {
						text: '',
					},
					legend: {
						enabled: false,
					},
					plotOptions: {
						series: {
							lineWidth: 6,
							cropThreshold: 100000,
							turboThreshold: 100000,
							marker: {
								enabled: false,
							},
						},
					},
					xAxis: {
						type: 'datetime',
						plotBands: plotBands,
						title: {
							text: '',
							style: {
								color: 'rgba(255,255,255,0.8)',
								fontSize: '12px',
								fontWeight: 'normal',
							},
						},
						labels: {
							style: {
								color: 'rgba(255,255,255,0.8)',
								fontSize: '12px',
								fontWeight: 'normal',
							},
						},
						gridLineWidth: 2,
						gridLineColor: 'rgba(255,255,255,0.1)',
						lineColor: 'rgba(255,255,255,0.1)',
						tickColor: 'rgba(255,255,255,0.1)',
					},
					yAxis: {
						title: {
							text: '',
							style: {
								color: 'rgba(255,255,255,0.8)',
								fontSize: '12px',
								fontWeight: 'normal',
							},
						},
						labels: {
							style: {
								color: 'rgba(255,255,255,0.8)',
								fontSize: '12px',
								fontWeight: 'normal',
							},
						},
						min: 0,
						gridLineWidth: 1,
						gridLineColor: 'rgba(255,255,255,0.1)',
						lineColor: 'rgba(255,255,255,0.1)',
						tickColor: 'rgba(255,255,255,0.1)',
					},
					series: [
						{
							data: pressureData,
							name: 'Pressure',
							color: '#7c3aed',
							lineWidth: 8,
						},
						{
							data: olcumData,
							name: 'Measurement',
							color: '#FF0000',
							lineWidth: 10,
						},
					],
				},
			},
		};

		// Initialize exporter if needed
		const exportSettings = exporter.setOptions(options);

		// Perform an export
		await exporter.initExport(exportSettings);

		await exporter.startExport(exportSettings, async (error, info) => {
			// The export result is now in info
			// It will be base64 encoded (info.result)

			res.contentType('image/png');
			res.send(Buffer.from(info.result, 'base64'));

			// Kill the pool when we are done with it
		});
	} catch (error) {
		console.error('Chart generation error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Test endpoint to create sample session profile
router.get('/testChart', async (req, res) => {
	try {
		// Create a sample profile for testing
		const sampleProfile = [
			[10, 0, 'air'], // 10 minutes descent to 0 bar
			[5, 2.4, 'air'], // 5 minutes descent to 2.4 bar (equivalent to 33 feet)
			[20, 2.4, 'o2'], // 20 minutes at depth with oxygen
			[15, 2.4, 'air'], // 15 minutes at depth with air
			[10, 2.4, 'o2'], // 10 minutes at depth with oxygen
			[20, 0, 'air'], // 20 minutes ascent to surface
		];

		// Initialize global.sessionStatus if it doesn't exist
		if (!global.sessionStatus) {
			global.sessionStatus = {};
		}

		// Set the sample profile to global sessionStatus
		global.sessionStatus.profile = sampleProfile;

		res.json({
			message:
				'Sample profile created successfully. You can now call /getChart to see the graph.',
			profile: sampleProfile,
		});
	} catch (error) {
		console.error('Test chart error:', error);
		res.status(500).json({ error: error.message });
	}
});

// Yeni hasta ekle
router.post('/patients', async (req, res) => {
	try {
		const { fullName, birthDate, gender } = req.body;
		const patient = await db.patients.create({
			fullName,
			birthDate,
			gender,
		});
		res.status(201).json(patient);
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

// Hasta listesini getir
router.get('/patients', async (req, res) => {
	try {
		const patients = await db.patients.findAll();
		res.json(patients);
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

module.exports = router;
