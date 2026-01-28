/**
 * Supabase Client Configuration
 *
 * Handles Supabase connection for cloud sync functionality.
 * Uses service role key for chamber servers (full access).
 */

const { createClient } = require('@supabase/supabase-js');

let supabaseInstance = null;

/**
 * Initialize Supabase client
 * @param {string} url - Supabase project URL
 * @param {string} key - Supabase service role key (for chamber servers)
 * @returns {object} Supabase client instance
 */
function initializeSupabase(url, key) {
    if (!url || !key) {
        throw new Error('Supabase URL and key are required');
    }

    supabaseInstance = createClient(url, key, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        },
        global: {
            headers: {
                'x-client-info': 'stack-control-chamber'
            }
        }
    });

    return supabaseInstance;
}

/**
 * Get the current Supabase client instance
 * @returns {object|null} Supabase client or null if not initialized
 */
function getSupabase() {
    return supabaseInstance;
}

/**
 * Check if Supabase connection is working
 * @returns {Promise<boolean>} True if connected, false otherwise
 */
async function checkConnection() {
    if (!supabaseInstance) {
        return false;
    }

    try {
        const { error } = await supabaseInstance
            .from('chambers')
            .select('id')
            .limit(1);

        return !error;
    } catch (err) {
        console.error('Supabase connection check failed:', err.message);
        return false;
    }
}

/**
 * Close/reset the Supabase connection
 */
function closeConnection() {
    supabaseInstance = null;
}

module.exports = {
    initializeSupabase,
    getSupabase,
    checkConnection,
    closeConnection
};
