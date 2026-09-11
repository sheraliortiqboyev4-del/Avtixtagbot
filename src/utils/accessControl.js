const SystemSetting = require('../models/SystemSetting');

const APPROVAL_SETTING_KEY = 'approval_required';
const DEFAULT_APPROVAL_REQUIRED = true;

const parseBoolean = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    return String(value).toLowerCase() !== 'false';
};

const isApprovalRequired = async () => {
    const [setting] = await SystemSetting.findOrCreate({
        where: { key: APPROVAL_SETTING_KEY },
        defaults: { value: String(DEFAULT_APPROVAL_REQUIRED) }
    });
    return parseBoolean(setting.value, DEFAULT_APPROVAL_REQUIRED);
};

const setApprovalRequired = async (required) => {
    await SystemSetting.upsert({
        key: APPROVAL_SETTING_KEY,
        value: String(Boolean(required))
    });
    return Boolean(required);
};

module.exports = {
    isApprovalRequired,
    setApprovalRequired
};
