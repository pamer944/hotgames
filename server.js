const express = require('express');
const {
    pool, initDB, bwinners,
    getAccounts, getAccountByTabId,
    claimFreeAccount, reLoginForTab, updateAccount,
    addAccount, removeAccount, resetAllAccounts, deleteAllAccounts,
    getBadPasswordAccounts, addBadPasswordAccount, removeBadPasswordAccount,
    getZambiaTime,
    REMOVE_PASSWORD, HEARTBEAT_TIMEOUT_MS, TIMEZONE
} = require('./accounts');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

function pad(n) {
    return String(n).padStart(2, '0');
}

const HEARTBEAT_SILENCE_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

app.post('/add-account', async (req, res) => {
    try {
        const { phone, password } = req.body || {};

        if (!phone || !password) {
            return res.json({ success: false, error: 'Phone and password required.' });
        }

        const existing = (await bwinners.getAccounts()).some(a => a.phone === phone);
        if (existing) {
            return res.json({ success: false, error: 'Account already exists.' });
        }

        await bwinners.addAccount(phone, password);
        res.json({ success: true });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

async function setupPool(name, base, store, alertsTable) {
    // Accounts become available 24 hours after logout.

    setInterval(async () => {
        try {
            const accounts = await store.getAccounts();
            const now = Date.now();

            for (const acc of accounts) {
                if (
                    acc.status === 'IN-USE' &&
                    acc.logoutTime &&
                    (now - acc.logoutTime >= TWENTY_FOUR_HOURS_MS)
                ) {
                    await store.updateAccount(acc.phone, {
                        status: 'FREE',
                        logoutTime: null,
                        logoutTimeStr: null,
                        lastHeartbeat: null,
                        inUseSince: null,
                        tabId: null,
                        freedAt: now
                    });
                }
            }
        } catch (e) {
            console.error('auto-free error:', e);
        }
    }, 60 * 1000);

    setInterval(async () => {
        try {
            const accounts = await store.getAccounts();
            const now = Date.now();

            for (const acc of accounts) {
                if (
                    acc.status === 'IN-USE' &&
                    !acc.logoutTime &&
                    acc.lastHeartbeat &&
                    acc.inUseSince &&
                    acc.lastHeartbeat > acc.inUseSince &&
                    now - acc.lastHeartbeat > HEARTBEAT_TIMEOUT_MS
                ) {
                    const { hour, minute } = getZambiaTime();

                    await store.updateAccount(acc.phone, {
                        logoutTime: Date.now(),
                        logoutTimeStr: pad(hour) + ':' + pad(minute) + ' (tab closed)',
                        inUseSince: null,
                        tabId: null
                    });
                }
            }
        } catch (e) {
            console.error('heartbeat-check error:', e);
        }
    }, 10 * 1000);

    setInterval(async () => {
        try {
            const accounts = await store.getAccounts();
            const now = Date.now();

            for (const acc of accounts) {
                if (
                    acc.status === 'IN-USE' &&
                    !acc.logoutTime &&
                    acc.lastHeartbeat &&
                    now - acc.lastHeartbeat > HEARTBEAT_SILENCE_TIMEOUT_MS
                ) {
                    const { hour, minute } = getZambiaTime();

                    await store.updateAccount(acc.phone, {
                        logoutTime: Date.now(),
                        logoutTimeStr: pad(hour) + ':' + pad(minute) + ' (3h no heartbeat)',
                        inUseSince: null,
                        tabId: null
                    });
                }
            }
        } catch (e) {
            console.error('timeout-check error:', e);
        }
    }, 60 * 1000);

    // API ENDPOINTS

    app.get(base + '/stats', async (req, res) => {
        try {
            const accounts = await store.getAccounts();
            const badPasswordAccounts = await store.getBadPasswordAccounts();

            res.json({
                free: accounts.filter(a => a.status === 'FREE').length,
                inUse: accounts.filter(a => a.status === 'IN-USE' && !a.logoutTime).length,
                waiting: accounts.filter(a => a.status === 'IN-USE' && a.logoutTime).length,
                badPassword: badPasswordAccounts.length,
                locked: false,
                reason: ''
            });

        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get(base + '/inuse-stats', async (req, res) => {
        try {
            const accounts = await store.getAccounts();

            const list = accounts
                .filter(a => a.status === 'IN-USE' && !a.logoutTime)
                .sort((a, b) => {
                    const aNum = a.tabId ? parseInt(a.tabId.replace('TAB-', '')) : 9999;
                    const bNum = b.tabId ? parseInt(b.tabId.replace('TAB-', '')) : 9999;
                    return aNum - bNum;
                })
                .map(a => ({
                    phone: a.phone,
                    lastHeartbeat: a.lastHeartbeat,
                    tabId: a.tabId
                }));

            res.json(list);

        } catch (e) {
            res.status(500).json([]);
        }
    });

    app.post(base + '/heartbeat', async (req, res) => {
        try {
            const { phone } = req.body;
            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (account && account.status === 'IN-USE') {
                await store.updateAccount(phone, {
                    lastHeartbeat: Date.now()
                });

                return res.json({ success: true });
            }

            res.json({
                success: false,
                error: 'Account not found or not in use.'
            });

        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/tab-closed', express.text({ type: '*/*' }), async (req, res) => {
        try {
            let phone;

            if (typeof req.body === 'string') {
                phone = JSON.parse(req.body).phone;
            } else if (req.body && req.body.phone) {
                phone = req.body.phone;
            }

            if (!phone) return res.json({ success: false });

            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (account && account.status === 'IN-USE' && !account.logoutTime) {
                const { hour, minute } = getZambiaTime();

                await store.updateAccount(phone, {
                    logoutTime: Date.now(),
                    logoutTimeStr: pad(hour) + ':' + pad(minute) + ' (tab closed)'
                });
            }

            res.json({ success: true });

        } catch (e) {
            res.json({ success: false });
        }
    });

    app.post(base + '/request-login', async (req, res) => {
        try {
            const { tabId } = req.body;

            if (!tabId) {
                return res.json({
                    success: false,
                    error: 'Tab ID required.'
                });
            }

            const { hour, minute } = getZambiaTime();

            const claimed = await store.reLoginForTab(
                tabId,
                Date.now(),
                pad(hour) + ':' + pad(minute)
            );

            if (claimed) {
                return res.json({
                    success: true,
                    phone: claimed.phone,
                    password: claimed.password
                });
            }

            return res.json({
                success: false,
                error: 'No free accounts available'
            });

        } catch (e) {
            console.error('request-login error:', e);
            res.json({
                success: false,
                error: 'Server error'
            });
        }
    });

    app.post(base + '/logout', async (req, res) => {
        try {
            const { phone, logoutTime } = req.body;
            const accounts = await store.getAccounts();
            const account = accounts.find(a => a.phone === phone);

            if (account) {
                await store.updateAccount(phone, {
                    logoutTime: Date.now(),
                    logoutTimeStr: logoutTime,
                    lastHeartbeat: null,
                    inUseSince: null,
                    tabId: null
                });

                return res.json({ success: true });
            }

            res.json({
                success: false,
                error: 'Account not found.'
            });

        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/wrong-password', async (req, res) => {
        try {
            const { phone } = req.body;

            if (!phone) return res.json({ success: false });

            const { hour, minute } = getZambiaTime();
            const accounts = await store.getAccounts();
            const acc = accounts.find(a => a.phone === phone) || {
                phone,
                password: 'unknown'
            };

            await store.removeAccount(phone);

            await store.addBadPasswordAccount(
                acc.phone,
                acc.password,
                pad(hour) + ':' + pad(minute)
            );

            res.json({ success: true });

        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/remove-account', async (req, res) => {
        try {
            const { phone, pin } = req.body;

            if (pin !== REMOVE_PASSWORD) {
                return res.json({
                    success: false,
                    error: 'Incorrect password.'
                });
            }

            if (!phone) {
                return res.json({
                    success: false,
                    error: 'Phone number required.'
                });
            }

            await store.removeAccount(phone);
            res.json({ success: true });

        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/remove-bad-password', async (req, res) => {
        try {
            const { phone, pin } = req.body;

            if (pin !== REMOVE_PASSWORD) {
                return res.json({
                    success: false,
                    error: 'Incorrect password.'
                });
            }

            if (!phone) {
                return res.json({
                    success: false,
                    error: 'Phone number required.'
                });
            }

            await store.removeBadPasswordAccount(phone);
            res.json({ success: true });

        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/cashout', async (req, res) => {
        try {
            const { tabId, amount, timestamp } = req.body;

            if (!tabId || !tabId.startsWith('ID:')) {
                return res.json({
                    ok: false,
                    error: 'Invalid tabId'
                });
            }

            await pool.query(
                'INSERT INTO ' + alertsTable + ' (tab_id, amount, timestamp) VALUES ($1, $2, $3)',
                [tabId, amount || 0, timestamp || Date.now()]
            );

            console.log('[ALERT] Recorded:', tabId);
            res.json({ ok: true });

        } catch (e) {
            console.error('cashout error:', e);
            res.status(500).json({ ok: false });
        }
    });

    app.post(base + '/clear-alerts', async (req, res) => {
        try {
            await pool.query('DELETE FROM ' + alertsTable);
            res.json({ ok: true });

        } catch (e) {
            res.status(500).json({ ok: false });
        }
    });

    app.get(base + '/alerts', async (req, res) => {
        try {
            const { rows } = await pool.query(
                'SELECT * FROM ' + alertsTable + ' ORDER BY id ASC'
            );

            res.json(rows.map(r => ({
                tabId: r.tab_id,
                amount: parseFloat(r.amount),
                timestamp: parseInt(r.timestamp)
            })));

        } catch (e) {
            res.status(500).json([]);
        }
    });

    app.post(base + '/reset', async (req, res) => {
        try {
            await store.resetAllAccounts();
            res.json({ success: true });

        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    app.post(base + '/wipe-all-accounts', async (req, res) => {
        try {
            const { pin } = req.body || {};

            if (pin !== REMOVE_PASSWORD) {
                return res.json({
                    success: false,
                    error: 'Incorrect password.'
                });
            }

            await store.deleteAllAccounts();
            res.json({ success: true });

        } catch (e) {
            console.error('wipe-all-accounts error:', e);
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
    });

    // VIEW PAGES

    app.get(base + '/view/free', async (req, res) => {
        try {
            const accounts = await store.getAccounts();

            const list = accounts
                .filter(a => a.status === 'FREE')
                .sort((a, b) => {
                    if (a.freedAt && b.freedAt) return a.freedAt - b.freedAt;
                    if (a.freedAt) return -1;
                    if (b.freedAt) return 1;
                    return 0;
                });

            const rows = list.map((r, i) =>
                `<div class="row" data-phone="${r.phone}">
                    <div class="rn">${i + 1}.</div>
                    <div class="ri">
                        <div class="rp">${r.phone}</div>
                        <div class="rs">${r.password}</div>
                        <button class="rb" onclick="store.removeAccount('${r.phone}')">Remove</button>
                    </div>
                </div>`
            ).join('') || '<div class="empty">No accounts</div>';

            res.send(listPage(
                'Free Accounts',
                list.length + ' ready',
                rows,
                true,
                base
            ));

        } catch (e) {
            res.status(500).send('Error');
        }
    });

    app.get(base + '/view/inuse', async (req, res) => {
        try {
            const accounts = await store.getAccounts();

            const list = accounts
                .filter(a => a.status === 'IN-USE' && !a.logoutTime)
                .sort((a, b) => {
                    const an = a.tabId ? parseInt(a.tabId.replace('TAB-', '')) : 9999;
                    const bn = b.tabId ? parseInt(b.tabId.replace('TAB-', '')) : 9999;
                    return an - bn;
                });

            const rows = list.map((r, i) =>
                `<div class="row" data-phone="${r.phone}">
                    <div class="rn">${i + 1}.</div>
                    <div class="ri">
                        <div class="rp">${r.phone}</div>
                        <div class="rs" id="hb-${i}">checking...</div>
                    </div>
                </div>`
            ).join('') || '<div class="empty">No accounts</div>';

            res.send(`<!DOCTYPE html>
<html>
<head>
<title>BWINNERS - In Use</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#04060a;padding:20px;min-height:100vh}
.page{background:#0d1117;border-radius:16px;max-width:520px;margin:0 auto;overflow:hidden}
.ph{padding:16px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:12px}
.back{background:#161b22;border:1px solid #30363d;color:#8b949e;padding:6px 12px;border-radius:8px;font-size:12px;text-decoration:none}
.pt{font-size:15px;font-weight:500;color:#e6edf3}
.ps{font-size:11px;color:#4b5563}
.sw{padding:14px 20px;border-bottom:1px solid #21262d}
.si{width:100%;background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:10px 14px;border-radius:8px;font-size:13px;outline:none}
.row{display:flex;align-items:center;padding:12px 20px;border-bottom:1px solid #161b22;gap:10px}
.rn{font-size:12px;color:#4b5563;width:26px}
.ri{flex:1}
.rp{font-size:14px;color:#e6edf3;font-weight:500}
.rs{font-size:11px;margin-top:3px}
.alive{color:#3fb950}.warn{color:#fbbf24}.dead{color:#f87171}
.empty{padding:40px;text-align:center;color:#4b5563;font-size:13px}
.hidden{display:none}
</style>
</head>
<body>
<div class="page">
<div class="ph">
<a href="${base}/" class="back">&#8592; BWINNERS</a>
<div><div class="pt">In Use</div><div class="ps">${list.length} accounts</div></div>
</div>
<div class="sw"><input class="si" placeholder="Search..." oninput="filterRows(this.value)"></div>
<div id="list">${rows}</div>
</div>
<script>
function filterRows(q) {
    document.querySelectorAll('.row').forEach(r => {
        r.classList.toggle('hidden', q !== '' && !r.dataset.phone.includes(q));
    });
}
function updateHB() {
    fetch('${base}/inuse-stats')
        .then(r => r.json())
        .then(data => {
            data.forEach((a, i) => {
                const el = document.getElementById('hb-' + i);
                if (!el) return;
                if (!a.lastHeartbeat) {
                    el.className = 'rs warn';
                    el.textContent = 'Waiting for heartbeat' + (a.tabId ? ' - ' + a.tabId : '');
                    return;
                }
                const s = Math.floor((Date.now() - a.lastHeartbeat) / 1000);
                if (s < 5) {
                    el.className = 'rs alive';
                    el.textContent = 'OK - ' + s + 's ago' + (a.tabId ? ' - ' + a.tabId : '');
                } else if (s < 30) {
                    el.className = 'rs warn';
                    el.textContent = 'Slow - ' + s + 's ago' + (a.tabId ? ' - ' + a.tabId : '');
                } else {
                    el.className = 'rs dead';
                    el.textContent = 'No heartbeat - ' + s + 's ago' + (a.tabId ? ' - ' + a.tabId : '');
                }
            });
        }).catch(() => {});
}
setInterval(updateHB, 1000);
updateHB();
</script>
</body>
</html>`);

        } catch (e) {
            res.status(500).send('Error');
        }
    });

    app.get(base + '/view/waiting', async (req, res) => {
        try {
            const accounts = await store.getAccounts();

            const list = accounts
                .filter(a => a.status === 'IN-USE' && a.logoutTime)
                .map(a => ({
                    phone: a.phone,
                    freeAt: a.logoutTime + TWENTY_FOUR_HOURS_MS,
                    logoutTimeStr: a.logoutTimeStr
                }))
                .sort((a, b) => a.freeAt - b.freeAt);

            const freeAtData = JSON.stringify(
                list.map((r, i) => ({ id: i, freeAt: r.freeAt }))
            );

            const rows = list.map((r, i) =>
                `<div class="row" data-phone="${r.phone}">
                    <div class="rn">${i + 1}.</div>
                    <div class="ri">
                        <div class="rp">${r.phone}</div>
                        <div class="rs" id="cd-${i}">calculating...</div>
                        ${r.logoutTimeStr ? `<div class="rn2">${r.logoutTimeStr}</div>` : ''}
                    </div>
                </div>`
            ).join('') || '<div class="empty">No accounts</div>';

            res.send(`<!DOCTYPE html>
<html>
<head>
<title>BWINNERS - Waiting 24 hours</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#04060a;padding:20px;min-height:100vh}
.page{background:#0d1117;border-radius:16px;max-width:520px;margin:0 auto;overflow:hidden}
.ph{padding:16px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:12px}
.back{background:#161b22;border:1px solid #30363d;color:#8b949e;padding:6px 12px;border-radius:8px;font-size:12px;text-decoration:none}
.pt{font-size:15px;font-weight:500;color:#e6edf3}
.ps{font-size:11px;color:#4b5563}
.sw{padding:14px 20px;border-bottom:1px solid #21262d}
.si{width:100%;background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:10px 14px;border-radius:8px;font-size:13px;outline:none}
.row{display:flex;align-items:center;padding:12px 20px;border-bottom:1px solid #161b22;gap:10px}
.rn{font-size:12px;color:#4b5563;width:26px}
.rn2{font-size:10px;color:#4b5563;margin-top:2px}
.ri{flex:1}
.rp{font-size:14px;color:#e6edf3;font-weight:500}
.rs{font-size:11px;color:#fbbf24;margin-top:3px}
.empty{padding:40px;text-align:center;color:#4b5563;font-size:13px}
.hidden{display:none}
</style>
</head>
<body>
<div class="page">
<div class="ph">
<a href="${base}/" class="back">&#8592; BWINNERS</a>
<div><div class="pt">Waiting 24 hours</div><div class="ps">${list.length} accounts</div></div>
</div>
<div class="sw"><input class="si" placeholder="Search..." oninput="filterRows(this.value)"></div>
<div id="list">${rows}</div>
</div>
<script>
function pad(n) { return String(n).padStart(2, '0'); }
const data = ${freeAtData};
function updateCD() {
    const now = Date.now();
    data.forEach(item => {
        const el = document.getElementById('cd-' + item.id);
        if (!el) return;
        const diff = item.freeAt - now;
        if (diff <= 0) {
            el.textContent = 'Ready';
            el.style.color = '#3fb950';
        } else {
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            el.textContent = 'Free in: ' + pad(h) + 'h ' + pad(m) + 'm ' + pad(s) + 's';
        }
    });
}
function filterRows(q) {
    document.querySelectorAll('.row').forEach(r => {
        r.classList.toggle('hidden', q !== '' && !r.dataset.phone.includes(q));
    });
}
setInterval(updateCD, 1000);
updateCD();
</script>
</body>
</html>`);

        } catch (e) {
            res.status(500).send('Error');
        }
    });

    app.get(base + '/view/bad', async (req, res) => {
        try {
            const list = await store.getBadPasswordAccounts();

            const rows = list.map((r, i) =>
                `<div class="row" data-phone="${r.phone}">
                    <div class="rn">${i + 1}.</div>
                    <div class="ri">
                        <div class="rp">${r.phone}</div>
                        <div class="rs">${r.password}</div>
                        ${r.reportedAt ? `<div class="rt">Reported: ${r.reportedAt}</div>` : ''}
                    </div>
                    <button class="rb" onclick="store.removeAccount('${r.phone}')">Remove</button>
                </div>`
            ).join('') || '<div class="empty">No accounts</div>';

            res.send(listPage(
                'Bad Password',
                list.length + ' accounts',
                rows,
                true,
                base
            ));

        } catch (e) {
            res.status(500).send('Error');
        }
    });

    function listPage(title, subtitle, rows, showRemove, basePath) {
        const removeEndpoint = title === 'Bad Password'
            ? 'remove-bad-password'
            : 'remove-account';

        return `<!DOCTYPE html>
<html>
<head>
<title>BWINNERS - ${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#04060a;padding:20px;min-height:100vh}
.page{background:#0d1117;border-radius:16px;max-width:520px;margin:0 auto;overflow:hidden}
.ph{padding:16px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:12px}
.back{background:#161b22;border:1px solid #30363d;color:#8b949e;padding:6px 12px;border-radius:8px;font-size:12px;text-decoration:none}
.pt{font-size:15px;font-weight:500;color:#e6edf3}
.ps{font-size:11px;color:#4b5563}
.sw{padding:14px 20px;border-bottom:1px solid #21262d}
.si{width:100%;background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:10px 14px;border-radius:8px;font-size:13px;outline:none}
.row{display:flex;align-items:center;padding:12px 20px;border-bottom:1px solid #161b22;gap:10px}
.row:last-child{border-bottom:none}
.rn{font-size:12px;color:#4b5563;width:26px}
.ri{flex:1}
.rp{font-size:14px;color:#e6edf3;font-weight:500}
.rs{font-size:11px;color:#4b5563;margin-top:2px}
.rt{font-size:10px;color:#f87171;margin-top:2px}
.rb{background:#2d0a0a;border:1px solid #7f1d1d;color:#f87171;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer}
.empty{padding:40px;text-align:center;color:#4b5563;font-size:13px}
.hidden{display:none}
.pm{position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px;z-index:100}
.pb{background:#0d1117;border:1.5px solid #21262d;border-radius:16px;padding:28px 24px;width:100%;max-width:320px;text-align:center}
.ptt{font-size:15px;font-weight:500;color:#e6edf3;margin-bottom:6px}
.ps2{font-size:12px;color:#4b5563;margin-bottom:20px}
.pi{width:100%;background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:12px;border-radius:8px;font-size:16px;outline:none;text-align:center;letter-spacing:4px;margin-bottom:14px}
.pr{display:flex;gap:10px}
.pc{flex:1;background:#161b22;border:1px solid #30363d;color:#8b949e;padding:10px;border-radius:8px;font-size:13px;cursor:pointer}
.pco{flex:1;background:#7f1d1d;border:none;color:#f87171;padding:10px;border-radius:8px;font-size:13px;cursor:pointer}
.pe{color:#f87171;font-size:12px;margin-top:10px;display:none}
</style>
</head>
<body>
<div class="page">
<div class="ph">
<a href="${basePath}/" class="back">&#8592; BWINNERS</a>
<div><div class="pt">${title}</div><div class="ps">${subtitle}</div></div>
</div>
<div class="sw"><input class="si" placeholder="Search..." oninput="filterRows(this.value)"></div>
<div id="list">${rows}</div>
</div>
${showRemove ? `
<div class="pm" id="modal" style="display:none">
<div class="pb">
<div class="ptt">&#128274; Confirm</div>
<div class="ps2">Enter password to remove</div>
<input class="pi" id="pin" type="password" maxlength="10" placeholder="Enter password" autocomplete="off">
<div class="pr">
<button class="pc" onclick="closeModal()">Cancel</button>
<button class="pco" id="remove-confirm" onclick="confirmRemove()">Remove</button>
</div>
<div class="pe" id="perr">Incorrect password</div>
</div>
</div>` : ''}
<script>
let pending = null;
let removing = false;

window.store = {
    removeAccount: function(phone) {
        pending = phone;
        const modal = document.getElementById('modal');
        const pin = document.getElementById('pin');
        const error = document.getElementById('perr');
        if (!modal || !pin || !error) return;
        pin.value = '';
        error.style.display = 'none';
        modal.style.display = 'flex';
        setTimeout(function() { pin.focus(); }, 50);
    }
};

function closeModal() {
    pending = null;
    removing = false;
    document.getElementById('modal').style.display = 'none';
    document.getElementById('pin').value = '';
}

async function confirmRemove() {
    if (removing || !pending) return;
    const pin = document.getElementById('pin').value.trim();
    const error = document.getElementById('perr');
    const button = document.getElementById('remove-confirm');

    if (pin !== '1234') {
        error.textContent = 'Incorrect password';
        error.style.display = 'block';
        document.getElementById('pin').value = '';
        document.getElementById('pin').focus();
        return;
    }

    removing = true;
    button.textContent = 'Removing...';

    try {
        const response = await fetch('${basePath}/${removeEndpoint}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: pending, pin: pin })
        });

        const result = await response.json();

        if (result.success) {
            const row = Array.from(document.querySelectorAll('.row'))
                .find(r => r.dataset.phone === pending);
            if (row) row.remove();
            closeModal();
        } else {
            error.textContent = result.error || 'Removal failed';
            error.style.display = 'block';
            removing = false;
            button.textContent = 'Remove';
        }

    } catch (e) {
        error.textContent = 'Connection error. Try again.';
        error.style.display = 'block';
        removing = false;
        button.textContent = 'Remove';
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const pin = document.getElementById('pin');
    if (pin) {
        pin.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') confirmRemove();
            if (e.key === 'Escape') closeModal();
        });
    }
});

function filterRows(q) {
    document.querySelectorAll('.row').forEach(r => {
        r.classList.toggle('hidden', q !== '' && !r.dataset.phone.includes(q));
    });
}
</script>
</body>
</html>`;
    }

    // MAIN BWINNERS DASHBOARD

    app.get(base || '/', async (req, res) => {
        try {
            const accounts = await store.getAccounts();
            const freeAccounts = accounts.filter(a => a.status === 'FREE');
            const inUseAccounts = accounts.filter(a => a.status === 'IN-USE' && !a.logoutTime);
            const waitingAccounts = accounts.filter(a => a.status === 'IN-USE' && a.logoutTime);
            const badPasswordAccounts = await store.getBadPasswordAccounts();

            res.send(`<!DOCTYPE html>
<html>
<head>
<title>BWINNERS - Account Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#04060a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.db{background:#080b10;border-radius:20px;padding:24px;width:100%;max-width:760px}
.top-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.db-title{font-size:18px;font-weight:600;color:#fff}
.pill{padding:6px 14px;border-radius:20px;font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px}
.pill-live{background:#0d4429;color:#3fb950}
.dot{width:7px;height:7px;border-radius:50%;animation:blink 1.2s infinite;background:#3fb950}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.15}}
.boxes{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px}
.box{border-radius:14px;padding:16px 14px;display:flex;flex-direction:column}
.box-free{background:#0a1a0f;border:1.5px solid #1a4a27}
.box-inuse{background:#080f1f;border:1.5px solid #1a2f55}
.box-waiting{background:#120c22;border:1.5px solid #2e1f55}
.bl{font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px}
.c-free{color:#3fb950}.c-inuse{color:#58a6ff}.c-waiting{color:#c4b5fd}
.bn{font-size:48px;font-weight:500;line-height:1;letter-spacing:-2px;margin-bottom:6px}
.bd{font-size:11px;margin-bottom:12px;flex:1}
.d-free{color:#2a6e3a}.d-inuse{color:#1e4a7a}.d-waiting{color:#4a3080}
.vbtn{width:100%;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px;border:none;background:#92400e;color:#fed7aa;text-decoration:none}
.vcnt{background:#fed7aa;color:#92400e;border-radius:20px;padding:1px 7px;font-size:10px;font-weight:700}
.add-box{background:#0d1117;border:1.5px solid #21262d;border-radius:12px;padding:18px 20px;margin-bottom:16px}
.add-title{font-size:12px;font-weight:600;color:#8b949e;margin-bottom:12px;letter-spacing:0.5px;text-transform:uppercase}
.add-row{display:flex;gap:8px;flex-wrap:wrap}
.add-input{flex:1;min-width:110px;background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:10px 12px;border-radius:8px;font-size:13px;outline:none}
.add-input::placeholder{color:#4b5563}
.add-btn{background:#1a3a6e;border:none;color:#a8d0ff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer}
.msg{font-size:12px;margin-top:8px;padding:7px 10px;border-radius:6px;display:none}
.msg-ok{background:#0d4429;color:#3fb950}.msg-err{background:#4b1111;color:#f87171}
.alerts-area{margin-bottom:16px}
.abtn-row{display:flex;gap:10px;margin-bottom:10px}
.abtn{flex:1;background:#1e293b;color:#fff;border:none;padding:14px 16px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer}
.abtn-clear{background:#ef4444;color:#fff;border:none;padding:14px 18px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer}
.apanel{display:none}
.ahide{width:100%;background:#0f172a;color:#fff;border:none;padding:12px;border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;margin-bottom:12px}
.abox{margin-bottom:14px}
.abox-header{background:#0d1117;border-radius:12px 12px 0 0;padding:10px 14px;display:flex;justify-content:space-between;align-items:center}
.abox-title{font-size:11px;font-weight:800;color:#f1f5f9;letter-spacing:2px}
.abox-count{font-size:10px;font-weight:700;background:#1e293b;color:#94a3b8;padding:3px 8px;border-radius:20px}
.abox-count.full{background:#ef4444;color:#fff}
.abox-body{background:#161b22;border-radius:0 0 12px 12px;overflow:hidden}
.arow{display:flex;align-items:center;padding:9px 12px;border-bottom:1px solid #1a1a2e;gap:8px}
.arow:last-child{border-bottom:none}
.achips{display:flex;gap:8px;flex:1}
.achip{background:#0d1117;border-radius:7px;padding:7px 12px}
.achip-id{font-size:13px;font-weight:800;color:#e6edf3}
.achip-ph{font-size:11px;font-weight:600;color:#e6edf3;font-family:monospace}
.anum{font-size:11px;font-weight:800;color:#4b5563;min-width:20px;text-align:right}
.aempty{padding:20px;text-align:center;color:#4b5563;font-size:13px}
.footer{display:flex;justify-content:space-between;align-items:center;margin-top:14px}
.tick{font-size:11px;color:#3fb950;font-family:monospace;opacity:0.7}
.hint{font-size:10px;color:#252b35}
@media(max-width:600px){.boxes{gap:8px}.box{padding:14px 10px}.bn{font-size:32px}}
</style>
</head>
<body>
<div class="db">
<div class="top-bar">
    <div class="db-title">&#127918; BWINNERS - Location 4</div>
    <div id="pill" class="pill pill-live"><div class="dot"></div><span id="pill-text">Live</span></div>
</div>

<div class="boxes">
    <div class="box box-free">
        <div class="bl c-free">&#10003; Free</div>
        <div class="bn c-free" id="num-free">${freeAccounts.length}</div>
        <div class="bd d-free">Accounts ready</div>
        <a href="${base}/view/free" class="vbtn">View <span class="vcnt" id="cnt-free">${freeAccounts.length}</span></a>
    </div>
    <div class="box box-inuse">
        <div class="bl c-inuse">&#9654; In use</div>
        <div class="bn c-inuse" id="num-inuse">${inUseAccounts.length}</div>
        <div class="bd d-inuse">Not yet logged out</div>
        <a href="${base}/view/inuse" class="vbtn">View <span class="vcnt" id="cnt-inuse">${inUseAccounts.length}</span></a>
    </div>
    <div class="box box-waiting">
        <div class="bl c-waiting">&#9203; Waiting 24 hours</div>
        <div class="bn c-waiting" id="num-waiting">${waitingAccounts.length}</div>
        <div class="bd d-waiting">Until account becomes free</div>
        <a href="${base}/view/waiting" class="vbtn">View <span class="vcnt" id="cnt-waiting">${waitingAccounts.length}</span></a>
    </div>
</div>

<div class="add-box">
    <div class="add-title">&#43; Add BWINNERS account</div>
    <div class="add-row">
        <input class="add-input" id="inp-phone" placeholder="Phone number" type="text">
        <input class="add-input" id="inp-pass" placeholder="Password" type="text">
        <button class="add-btn" id="add-btn">Add</button>
    </div>
    <div class="msg" id="add-msg"></div>
</div>

<div class="alerts-area">
    <div class="abtn-row">
        <button class="abtn" id="view-btn">&#128065;&#65039; View IDs &amp; Numbers</button>
        <button class="abtn-clear" id="clear-btn">&#128260; Deposit / Clear</button>
    </div>
    <div class="apanel" id="apanel">
        <button class="ahide" id="hide-btn">&#128274; Hide IDs &amp; Numbers</button>
        <div id="acontainer"><div class="aempty">No low balance accounts yet...</div></div>
    </div>
</div>

<div class="footer">
    <span class="tick" id="tick">--:--:-- CAT</span>
    <span class="hint">Live data &middot; PostgreSQL &middot; Africa/Lusaka</span>
</div>
</div>

<div id="note-printable" style="position:fixed;left:-9999px;top:0;width:400px;background:#fff;padding:32px 28px;font-family:sans-serif;">
    <div id="note-title" style="font-size:16px;font-weight:900;color:#0f172a;margin-bottom:4px;"></div>
    <div id="note-date" style="font-size:11px;color:#94a3b8;margin-bottom:20px;"></div>
    <hr style="border:none;border-top:2px solid #e2e8f0;margin-bottom:16px;">
    <div id="note-rows"></div>
    <div style="margin-top:20px;font-size:10px;color:#cbd5e1;text-align:center;">BWINNERS - Location 4</div>
</div>

<style>
.note-row{display:flex;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a}
.note-row:last-child{border-bottom:none}
.note-num{font-size:11px;font-weight:700;color:#94a3b8;min-width:22px;text-align:right}
.note-id{font-weight:800}
.note-sep{color:#cbd5e1}
.note-phone{font-family:monospace;font-size:12px;color:#334155}
</style>

<script>
(function() {
    function pad(n) { return String(n).padStart(2, '0'); }

    function zambiaTime() {
        return new Date().toLocaleTimeString('en-GB', {
            timeZone: 'Africa/Lusaka',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    setInterval(function() {
        document.getElementById('tick').textContent = zambiaTime() + ' CAT';
    }, 1000);

    document.getElementById('tick').textContent = zambiaTime() + ' CAT';

    function refreshStats() {
        fetch('${base}/stats')
            .then(r => r.json())
            .then(d => {
                document.getElementById('num-free').textContent = d.free;
                document.getElementById('num-inuse').textContent = d.inUse;
                document.getElementById('num-waiting').textContent = d.waiting;
                document.getElementById('cnt-free').textContent = d.free;
                document.getElementById('cnt-inuse').textContent = d.inUse;
                document.getElementById('cnt-waiting').textContent = d.waiting;
            })
            .catch(() => {});
    }

    setInterval(refreshStats, 2000);
    refreshStats();

    function showMsg(text, ok) {
        var el = document.getElementById('add-msg');
        el.textContent = text;
        el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
        el.style.display = 'block';
        setTimeout(function() { el.style.display = 'none'; }, 3000);
    }

    document.getElementById('add-btn').addEventListener('click', function() {
        var phone = document.getElementById('inp-phone').value.trim();
        var password = document.getElementById('inp-pass').value.trim();

        if (!phone || !password) {
            showMsg('Phone and password required', false);
            return;
        }

        fetch('${base}/add-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: phone, password: password })
        })
        .then(r => r.json())
        .then(d => {
            if (d.success) {
                showMsg('Account added successfully', true);
                document.getElementById('inp-phone').value = '';
                document.getElementById('inp-pass').value = '';
                refreshStats();
            } else {
                showMsg(d.error || 'Could not add account', false);
            }
        })
        .catch(() => showMsg('Connection error', false));
    });

    var viewBtn = document.getElementById('view-btn');
    var hideBtn = document.getElementById('hide-btn');
    var clearBtn = document.getElementById('clear-btn');
    var panel = document.getElementById('apanel');

    viewBtn.addEventListener('click', function() {
        panel.style.display = 'block';
        loadAlerts();
    });

    hideBtn.addEventListener('click', function() {
        panel.style.display = 'none';
    });

    clearBtn.addEventListener('click', function() {
        var pin = prompt('Enter password to clear alerts:');
        if (pin !== '1234') {
            alert('Incorrect password');
            return;
        }

        fetch('${base}/clear-alerts', { method: 'POST' })
            .then(() => {
                renderAlerts([]);
                alert('Alerts cleared!');
            })
            .catch(() => alert('Error'));
    });

    function loadAlerts() {
        fetch('${base}/alerts')
            .then(r => r.json())
            .then(renderAlerts)
            .catch(() => {});
    }

    function renderAlerts(items) {
        var container = document.getElementById('acontainer');

        if (!items || !items.length) {
            container.innerHTML = '<div class="aempty">No low balance accounts yet...</div>';
            return;
        }

        var groups = {};
        items.forEach(function(item) {
            var id = item.tabId || 'Unknown';
            if (!groups[id]) groups[id] = [];
            groups[id].push(item);
        });

        var html = '';
        Object.keys(groups).forEach(function(id) {
            var group = groups[id];
            html += '<div class="abox">';
            html += '<div class="abox-header"><div class="abox-title">' + id + '</div>';
            html += '<div class="abox-count">' + group.length + '</div></div>';
            html += '<div class="abox-body">';

            group.forEach(function(item, i) {
                html += '<div class="arow"><div class="anum">' + (i + 1) + '.</div>';
                html += '<div class="achips"><div class="achip"><div class="achip-ph">' +
                    String(item.amount || '') + '</div></div></div></div>';
            });

            html += '</div></div>';
        });

        container.innerHTML = html;
    }

    setInterval(function() {
        if (panel.style.display === 'block') loadAlerts();
    }, 5000);

})();
</script>
</body>
</html>`);

        } catch (e) {
            console.error('dashboard error:', e);
            res.status(500).send('Error: ' + e.message);
        }
    });
}

initDB().then(async function() {
    await setupPool('BWINNERS', '', bwinners, 'alerts');

    app.listen(PORT, () => {
        console.log('BWINNERS active on port ' + PORT + ' -- Location 4 -- Africa/Lusaka');
    });

}).catch(function(err) {
    console.error('Failed to initialize BWINNERS database:', err);
    process.exit(1);
});
