/* global Telegram */
const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';

if (tg) {
    tg.ready();
    tg.expand();
}

const $ = (id) => document.getElementById(id);

function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2000);
}

async function api(path, body = {}) {
    const res = await fetch(path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Init-Data': initData
        },
        body: JSON.stringify({ initData, ...body })
    });
    return res.json();
}

function fmtExpire(expireAt) {
    if (!expireAt) return 'Cheksiz 👑';
    const diff = new Date(expireAt) - new Date();
    if (diff <= 0) return 'Tugagan ❌';
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    return `${d} kun ${h} soat`;
}

function renderAlmaz(enabled) {
    $('almazToggle').checked = enabled;
    const badge = $('almazState');
    badge.textContent = enabled ? '🟢 Yoqilgan' : '🔴 O\'chirilgan';
    badge.className = 'badge ' + (enabled ? 'on' : 'off');
}

async function load() {
    const data = await api('/api/state');
    if (!data.ok) { $('welcome').textContent = 'Xatolik yuz berdi'; return; }

    if (!data.registered) {
        $('welcome').textContent = 'Xush kelibsiz!';
        $('notReg').classList.remove('hidden');
        return;
    }

    const s = data.state;
    $('welcome').textContent = `Salom, ${s.name || 'Foydalanuvchi'}!`;

    const statusMap = { approved: '✅ Tasdiqlangan', pending: '⏳ Kutilmoqda', blocked: '🚫 Bloklangan' };
    $('userStatus').textContent = statusMap[s.status] || s.status;
    $('userTarif').textContent = s.subscriptionType || 'Oddiy';
    $('userExpire').textContent = fmtExpire(s.expireAt);

    $('stClicks').textContent = s.clicks || 0;
    $('stReyd').textContent = s.reydCount || 0;
    $('stUsers').textContent = s.usersGathered || 0;
    $('stAds').textContent = s.adsCount || 0;
    $('stUtag').textContent = s.utagCount || 0;

    $('statusCard').classList.remove('hidden');
    $('statsGrid').classList.remove('hidden');

    if (s.hasSession) {
        renderAlmaz(s.avtoAlmaz);
        $('almazCard').classList.remove('hidden');
    }
}

$('almazToggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    const data = await api('/api/almaz', { enabled });
    if (data.ok) {
        renderAlmaz(data.avtoAlmaz);
        toast(data.avtoAlmaz ? 'Avto Almaz yoqildi' : 'Avto Almaz o\'chirildi');
        tg?.HapticFeedback?.impactOccurred('light');
    } else {
        e.target.checked = !enabled; // qaytarish
        toast(data.error || 'Xatolik');
    }
});

load();
