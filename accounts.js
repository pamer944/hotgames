const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FREE_ACCOUNT_LOCK_THRESHOLD = 50;

const LOCK_HOUR = 20;
const LOCK_MINUTE = 0;
const UNLOCK_HOUR = 4;
const UNLOCK_MINUTE = 0;

const REMOVE_PASSWORD = process.env.REMOVE_PASSWORD || '';
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const TIMEZONE = 'Africa/Lusaka';

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS accounts (
            phone TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            status TEXT DEFAULT 'FREE',
            logout_time BIGINT DEFAULT NULL,
            logout_time_str TEXT DEFAULT NULL,
            last_heartbeat BIGINT DEFAULT NULL,
            in_use_since BIGINT DEFAULT NULL,
            tab_id TEXT DEFAULT NULL,
            freed_at BIGINT DEFAULT NULL
        );
    `);

    await pool.query(`
        ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS in_use_since BIGINT DEFAULT NULL;
    `);

    await pool.query(`
        ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS tab_id TEXT DEFAULT NULL;
    `);

    await pool.query(`
        ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS freed_at BIGINT DEFAULT NULL;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS alerts (
            id SERIAL PRIMARY KEY,
            tab_id TEXT,
            amount NUMERIC DEFAULT 0,
            timestamp BIGINT,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS bad_password_accounts (
            phone TEXT PRIMARY KEY,
            password TEXT,
            reported_at TEXT,
            status TEXT DEFAULT 'BAD_PASSWORD'
        );
    `);

    console.log('HOTGAMES Location 3 database initialized.');
}

function makeStore() {
    async function getAccounts() {
        const { rows } = await pool.query(
            `SELECT * FROM accounts ORDER BY phone ASC`
        );

        return rows.map(r => ({
            phone: r.phone,
            password: r.password,
            status: r.status,
            logoutTime: r.logout_time ? Number(r.logout_time) : null,
            logoutTimeStr: r.logout_time_str,
            lastHeartbeat: r.last_heartbeat
                ? Number(r.last_heartbeat)
                : null,
            inUseSince: r.in_use_since
                ? Number(r.in_use_since)
                : null,
            tabId: r.tab_id || null,
            freedAt: r.freed_at ? Number(r.freed_at) : null
        }));
    }

    async function getAccountByTabId(tabId) {
        const { rows } = await pool.query(
            `SELECT * FROM accounts
             WHERE tab_id = $1
             AND status = 'IN-USE'
             AND logout_time IS NULL
             LIMIT 1`,
            [tabId]
        );

        if (!rows.length) return null;

        const r = rows[0];

        return {
            phone: r.phone,
            password: r.password,
            status: r.status,
            logoutTime: r.logout_time
                ? Number(r.logout_time)
                : null,
            logoutTimeStr: r.logout_time_str,
            lastHeartbeat: r.last_heartbeat
                ? Number(r.last_heartbeat)
                : null,
            inUseSince: r.in_use_since
                ? Number(r.in_use_since)
                : null,
            tabId: r.tab_id || null,
            freedAt: r.freed_at ? Number(r.freed_at) : null
        };
    }

    async function reLoginForTab(tabId, heartbeatNow, logoutTimeStr) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            if (tabId) {
                const { rows: oldRows } = await client.query(
                    `SELECT phone FROM accounts
                     WHERE tab_id = $1
                     AND status = 'IN-USE'
                     AND logout_time IS NULL
                     LIMIT 1
                     FOR UPDATE SKIP LOCKED`,
                    [tabId]
                );

                if (oldRows.length) {
                    await client.query(
                        `UPDATE accounts
                         SET logout_time = $2,
                             logout_time_str = $3,
                             last_heartbeat = NULL,
                             in_use_since = NULL,
                             tab_id = NULL
                         WHERE phone = $1`,
                        [
                            oldRows[0].phone,
                            heartbeatNow,
                            logoutTimeStr + ' (re-login)'
                        ]
                    );
                }
            }

            const { rows: newRows } = await client.query(
                `SELECT phone, password FROM accounts
                 WHERE status = 'FREE'
                 ORDER BY freed_at ASC NULLS LAST
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED`
            );

            if (!newRows.length) {
                await client.query('ROLLBACK');
                return null;
            }

            const { phone, password } = newRows[0];

            await client.query(
                `UPDATE accounts
                 SET status = 'IN-USE',
                     logout_time = NULL,
                     logout_time_str = NULL,
                     last_heartbeat = $2,
                     in_use_since = $2,
                     tab_id = $3,
                     freed_at = NULL
                 WHERE phone = $1`,
                [phone, heartbeatNow, tabId || null]
            );

            await client.query('COMMIT');

            return { phone, password };

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async function claimFreeAccount(heartbeatNow, tabId) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const { rows } = await client.query(`
                SELECT phone, password
                FROM accounts
                WHERE status = 'FREE'
                ORDER BY freed_at ASC NULLS LAST
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            `);

            if (!rows.length) {
                await client.query('ROLLBACK');
                return null;
            }

            const { phone, password } = rows[0];

            await client.query(
                `UPDATE accounts
                 SET status = 'IN-USE',
                     logout_time = NULL,
                     logout_time_str = NULL,
                     last_heartbeat = $2,
                     in_use_since = $2,
                     tab_id = $3,
                     freed_at = NULL
                 WHERE phone = $1`,
                [phone, heartbeatNow, tabId || null]
            );

            await client.query('COMMIT');

            return { phone, password };

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async function updateAccount(phone, fields) {
        const map = {
            logoutTime: 'logout_time',
            logoutTimeStr: 'logout_time_str',
            lastHeartbeat: 'last_heartbeat',
            status: 'status',
            inUseSince: 'in_use_since',
            tabId: 'tab_id',
            freedAt: 'freed_at'
        };

        const keys = Object.keys(fields);

        if (!keys.length) return;

        const setClauses = keys.map((key, i) => {
            if (!map[key]) {
                throw new Error('Invalid account field: ' + key);
            }

            return `${map[key]} = $${i + 1}`;
        }).join(', ');

        const values = [
            ...keys.map(key => fields[key]),
            phone
        ];

        await pool.query(
            `UPDATE accounts
             SET ${setClauses}
             WHERE phone = $${values.length}`,
            values
        );
    }

    async function addAccount(phone, password) {
        await pool.query(
            `INSERT INTO accounts
             (phone, password, status)
             VALUES ($1, $2, 'FREE')`,
            [phone, password]
        );
    }

    async function removeAccount(phone) {
        await pool.query(
            `DELETE FROM accounts WHERE phone = $1`,
            [phone]
        );
    }

    async function resetAllAccounts() {
        await pool.query(`
            UPDATE accounts
            SET status = 'FREE',
                logout_time = NULL,
                logout_time_str = NULL,
                last_heartbeat = NULL,
                in_use_since = NULL,
                tab_id = NULL
        `);
    }

    async function deleteAllAccounts() {
        await pool.query(`DELETE FROM accounts`);
    }

    async function getBadPasswordAccounts() {
        const { rows } = await pool.query(
            `SELECT * FROM bad_password_accounts`
        );

        return rows.map(r => ({
            phone: r.phone,
            password: r.password,
            reportedAt: r.reported_at,
            status: r.status
        }));
    }

    async function addBadPasswordAccount(
        phone,
        password,
        reportedAt
    ) {
        await pool.query(
            `INSERT INTO bad_password_accounts
             (phone, password, reported_at)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [phone, password, reportedAt]
        );
    }

    async function removeBadPasswordAccount(phone) {
        await pool.query(
            `DELETE FROM bad_password_accounts
             WHERE phone = $1`,
            [phone]
        );
    }

    return {
        getAccounts,
        getAccountByTabId,
        reLoginForTab,
        claimFreeAccount,
        updateAccount,
        addAccount,
        removeAccount,
        resetAllAccounts,
        deleteAllAccounts,
        getBadPasswordAccounts,
        addBadPasswordAccount,
        removeBadPasswordAccount
    };
}

const hotgames = makeStore();

function getZambiaTime() {
    const now = new Date();

    const zambiaStr = now.toLocaleString('en-GB', {
        timeZone: TIMEZONE
    });

    const [, timePart] = zambiaStr.split(', ');
    const [hours, minutes, seconds] = timePart
        .split(':')
        .map(Number);

    return {
        hour: hours,
        minute: minutes,
        second: seconds
    };
}

module.exports = {
    pool,
    initDB,
    hotgames,

    getAccounts: hotgames.getAccounts,
    getAccountByTabId: hotgames.getAccountByTabId,
    claimFreeAccount: hotgames.claimFreeAccount,
    reLoginForTab: hotgames.reLoginForTab,
    updateAccount: hotgames.updateAccount,
    addAccount: hotgames.addAccount,
    removeAccount: hotgames.removeAccount,
    resetAllAccounts: hotgames.resetAllAccounts,
    deleteAllAccounts: hotgames.deleteAllAccounts,

    getBadPasswordAccounts: hotgames.getBadPasswordAccounts,
    addBadPasswordAccount: hotgames.addBadPasswordAccount,
    removeBadPasswordAccount: hotgames.removeBadPasswordAccount,

    getZambiaTime,
    SEVEN_DAYS_MS,
    FREE_ACCOUNT_LOCK_THRESHOLD,
    LOCK_HOUR,
    LOCK_MINUTE,
    UNLOCK_HOUR,
    UNLOCK_MINUTE,
    REMOVE_PASSWORD,
    HEARTBEAT_TIMEOUT_MS,
    TIMEZONE
};
