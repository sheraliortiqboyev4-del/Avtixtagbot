/**
 * Telegram Mini App (WebApp) — IZOLYATSIYALANGAN MODUL
 *
 * MUHIM: Bu modul mavjud bot logikasini O'ZGARTIRMAYDI.
 * Faqat Express'ga yangi route'lar qo'shadi va mavjud
 * (User modeli, avtoAlmazStates) bilan faqat O'QISH/oddiy toggle qiladi.
 *
 * Xavfsizlik: har bir API so'rovi Telegram initData HMAC imzosi orqali
 * tekshiriladi — bot tokeni bilan. Imzo noto'g'ri bo'lsa, so'rov rad etiladi.
 */

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const config = require('../config');
const User = require('../models/User');

/**
 * Telegram WebApp initData ni tekshirish (rasmiy algoritm).
 * Muvaffaqiyatli bo'lsa user obyektini qaytaradi, aks holda null.
 */
function verifyInitData(initData) {
    if (!initData || !config.botToken) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;
        params.delete('hash');

        const dataCheckString = [...params.entries()]
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(config.botToken)
            .digest();
        const computedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        if (computedHash !== hash) return null;

        // auth_date eskirganini ham tekshiramiz (24 soat)
        const authDate = parseInt(params.get('auth_date') || '0', 10);
        if (authDate && (Date.now() / 1000 - authDate) > 86400) return null;

        const userRaw = params.get('user');
        return userRaw ? JSON.parse(userRaw) : null;
    } catch (e) {
        console.error('[MiniApp] initData tekshirish xatosi:', e.message);
        return null;
    }
}

/**
 * Express middleware: initData ni tekshirib, req.tgUser ga yozadi.
 */
function authMiddleware(req, res, next) {
    const initData = req.get('X-Telegram-Init-Data') || req.body?.initData || '';
    const tgUser = verifyInitData(initData);
    if (!tgUser || !tgUser.id) {
        return res.status(401).json({ ok: false, error: 'Avtorizatsiya xatosi' });
    }
    req.tgUser = tgUser;
    next();
}

/**
 * Mini App'ni mavjud Express ilovasiga ulash.
 * @param {import('express').Express} app
 * @param {object} bot - telegram bot instance (hozircha shart emas, kelajak uchun)
 */
function setupMiniApp(app, bot) {
    // Statik fayllar (public/ papkasi) — Mini App UI
    app.use('/app', express.static(path.join(__dirname, '../../public')));
    app.use(express.json());

    // Foydalanuvchi holatini qaytarish (faqat o'qish)
    app.post('/api/state', authMiddleware, async (req, res) => {
        try {
            const chatId = req.tgUser.id;
            const user = await User.findOne({ where: { chatId } });
            if (!user) {
                return res.json({ ok: true, registered: false });
            }
            return res.json({
                ok: true,
                registered: true,
                state: {
                    name: user.name,
                    username: user.username,
                    status: user.status,
                    subscriptionType: user.subscriptionType,
                    expireAt: user.expireAt,
                    avtoAlmaz: user.avtoAlmaz,
                    clicks: user.clicks,
                    reydCount: user.reydCount,
                    usersGathered: user.usersGathered,
                    adsCount: user.adsCount,
                    utagCount: user.utagCount,
                    hasSession: !!user.session
                }
            });
        } catch (e) {
            console.error('[MiniApp] /api/state xatosi:', e.message);
            res.status(500).json({ ok: false, error: 'Server xatosi' });
        }
    });

    // Avto Almaz yoqish/o'chirish (mavjud logikaning aynan o'zi)
    app.post('/api/almaz', authMiddleware, async (req, res) => {
        try {
            const chatId = req.tgUser.id;
            const user = await User.findOne({ where: { chatId } });
            if (!user || !user.session) {
                return res.status(403).json({ ok: false, error: 'Avval botga kiring' });
            }

            const enabled = !!req.body.enabled;
            await User.update({ avtoAlmaz: enabled }, { where: { chatId } });

            // Mavjud userbot state'ini ham yangilaymiz (chatdagi tugma bilan bir xil)
            const { avtoAlmazStates } = require('../services/userbot');
            avtoAlmazStates[chatId] = enabled;

            return res.json({ ok: true, avtoAlmaz: enabled });
        } catch (e) {
            console.error('[MiniApp] /api/almaz xatosi:', e.message);
            res.status(500).json({ ok: false, error: 'Server xatosi' });
        }
    });

    console.log('🎨 Mini App ulandi: /app (UI) + /api/* (backend)');
}

module.exports = { setupMiniApp, verifyInitData };
