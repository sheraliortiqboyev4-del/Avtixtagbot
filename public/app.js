/* global Telegram */
const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';

if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#17212b'); tg.setBackgroundColor('#17212b'); } catch (e) {}
}

const $ = (id) => document.getElementById(id);

function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2000);
}

async function api(path, body = {}) {
    try {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
            body: JSON.stringify({ initData, ...body })
        });
        return await res.json();
    } catch (e) {
        return { ok: false, error: 'Ulanish xatosi' };
    }
}

function fmtExpire(expireAt) {
    if (!expireAt) return 'Cheksiz 👑';
    const diff = new Date(expireAt) - new Date();
    if (diff <= 0) return 'Tugagan ❌';
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    return `${d} kun ${h} soat`;
}

function setToggle(btn, on) {
    btn.classList.toggle('off', !on);
    const st = btn.querySelector('.state');
    st.textContent = on ? '🟢 ON' : '🔴 OFF';
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

    $('statsCard').classList.remove('hidden');
    $('featureGrid').classList.remove('hidden');

    // Avto Almaz haqiqiy holati
    const almazBtn = document.querySelector('[data-key="avtoAlmaz"]');
    setToggle(almazBtn, !!s.avtoAlmaz);
}

// Faqat Avto Almaz backend bilan ishlaydi; qolganlari namoyish
document.querySelectorAll('.btn-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        tg?.HapticFeedback?.impactOccurred('light');

        if (key === 'avtoAlmaz') {
            const turningOn = btn.classList.contains('off');
            const data = await api('/api/almaz', { enabled: turningOn });
            if (data.ok) {
                setToggle(btn, data.avtoAlmaz);
                toast(data.avtoAlmaz ? 'Avto Almaz yoqildi' : 'Avto Almaz o\'chirildi');
            } else {
                toast(data.error || 'Xatolik');
            }
        } else {
            // Boshqa funksiyalar bot chatida ishga tushiriladi
            toast('Bu funksiyani bot chatidan ishga tushiring');
        }
    });
});

document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
        tg?.HapticFeedback?.impactOccurred('light');
        toast('Bot chatidagi menyudan foydalaning');
    });
});

document.querySelectorAll('.btn-pro').forEach((btn) => {
    btn.addEventListener('click', () => {
        tg?.HapticFeedback?.impactOccurred('light');
        toast('Tez kunda...');
    });
});

load();
