# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stack Control is a Node.js/Express server application for controlling hyperbaric chamber systems. It manages PLC communication, sensor data processing, patient records, and session profiles for medical hyperbaric oxygen therapy.

## Commands

- `npm start` - Start the development server with nodemon (auto-reload)
- `npm run db:create` - Initialize/create SQLite database
- `npm run rebuild` - Rebuild native sqlite3 module
- `npm run clean` - Clean reinstall (removes node_modules and reinstalls)

For production, PM2 is used:
- `pm2 start ecosystem.config.js` - Start with PM2

## Architecture

### Entry Point
- `index.js` - Main server file. Initializes Express, Socket.IO client for PLC communication, database sync, and real-time WebSocket connections for views.

### Core Modules

**Database Layer** (`src/models/`)
- Uses Sequelize ORM with SQLite (`coral.sqlite`)
- `index.js` - Database connection and model aggregation
- Models: `sensor.model.js`, `config.model.js`, `patient.model.js`

**API Routes** (`src/routes/`)
- `index.js` - Main router, handles patient CRUD
- `sensors.js` - Sensor CRUD and bulk updates
- `config.js` - System configuration endpoints

**Utilities**
- `profile_manager.js` - `ProfileManager` class for managing dive/session profiles with pressure/time steps. Supports time-based arrays, interpolation, and Highcharts-compatible output
- `o2_calibration.js` - `SensorCalibration` class for 3-point polynomial calibration of O2 sensors
- `src/helpers/index.js` - Response helpers (`successResponse`, `errorResponse`) and `linearConversion` for sensor value mapping

### Key Patterns

**Global State**
- `global.appConfig` - System configuration loaded from database
- `global.sensorCalibrationData` - Sensor calibration data cached for runtime access

**Real-time Communication**
- Socket.IO client connects to PLC system
- WebSocket connections array (`connections`) broadcasts sensor data to UI clients

**Sensor Data Flow**
1. Raw values received from PLC via Socket.IO
2. Passed through `LowPassFilter` for smoothing (configurable alpha values per sensor type)
3. Calibrated using `SensorCalibration` or `linearConversion`
4. Broadcast to connected views via WebSocket

### Configuration

System configuration is stored in database and includes:
- O2 calibration points (0%, 21%, 100%)
- Filter alpha values for pressure, O2, temperature, humidity, CO2
- Compressor/decompression control parameters (offset, gain, depth)
- Default session parameters (dive time, exit time, total time, depth, speed)
- PLC connection settings (IP, port)
