const express = require('express');
const router = express.Router();
const db = require('../models/index');
const { errorResponse, successResponse } = require('../helpers/index');

router.get('/getConfig', async (req, res) => {
	try {
		const config = await db.config.findAll();
		successResponse(req, res, config);
	} catch (error) {
		errorResponse(req, res, error);
	}
});

module.exports = router;
