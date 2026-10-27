// 字段的中文名、撤离结果、干员和地图名称。
// 依据（2026-10-27 调研，见 outputs/deltaforce_site_design_Claude/_work/v1_field_research/）：
//   - 官方 WeGame 助手战绩页：gameResult === 0 显示「撤离成功」，其他值都显示「撤离失败」；
//     「击杀干员」这一列用的是 killPlayer；killCnt、assistCnt、rescue 官方烽火界面不显示（含义按第三方和旧版小程序）。
//   - 干员、地图名称：官方页面读腾讯公开的静态配置（jsonschema.qpic.cn 上的 agentInfo、map），同步时扩展在官方页面里照样读一次；
//     下面两张表是 2026-10-27 的快照，读不到时兜底。表里没有的 ID 显示成「干员#ID」「地图#ID」，不瞎猜。
export const LABELS = {
  matches: '局数',
  escaped: '撤离成功',
  gameResult: '结果',
  killPlayer: '击杀干员',
  killCnt: '总击杀',
  assistCnt: '助攻',
  rescue: '救助',
  gainedPrice: '带出价值',
  ProfitLoss: '盈亏',
  collections: '带出高价值物品',
};

export const isEscaped = code => Number(code) === 0;
export const gameResultText = code => (code === undefined || code === null || code === '' ? '' : Number(code) === 0 ? '撤离成功' : '撤离失败');

/** 物品品质：官方用 grade 上底色，6 = 红、5 = 金 */
export const GRADE = { 6: '红', 5: '金', 4: '紫', 3: '蓝', 2: '绿', 1: '灰', 0: '灰' };

export const ARMED_FORCES_SNAPSHOT = {
  10007: '红狼', 10010: '威龙', 10011: '无名', 10012: '疾风',
  20003: '蜂医', 20004: '蛊', 20005: '蝶', 20006: '旅人',
  30008: '牧羊人', 30009: '乌鲁鲁', 30010: '深蓝', 30011: '比特', 30012: '液氮',
  40005: '露娜', 40010: '骇爪', 40011: '银翼', 40012: '回响',
  50001: '赤枭', 50002: '赤枭亲卫', 50003: '赤枭亲卫',
  60001: '德穆兰', 60002: '重装兵', 60003: '通信兵',
};
export const MAPS_SNAPSHOT = {
  2201: '零号大坝-常规', 2211: '零号大坝-常规', 2202: '零号大坝-机密', 2212: '零号大坝-机密',
  2231: '零号大坝-永夜', 2232: '零号大坝-永夜', 2233: '零号大坝-永夜', 2242: '零号大坝-水淹', 2251: '零号大坝-烽火挑战',
  1901: '长弓溪谷-常规', 1911: '长弓溪谷-常规', 1902: '长弓溪谷-机密', 1912: '长弓溪谷-机密',
  8102: '巴克什-机密', 8103: '巴克什-绝密', 8151: '巴克什-烽火挑战',
  3901: '航天基地-机密', 3902: '航天基地-绝密', 3951: '航天基地-烽火挑战',
  8802: '潮汐监狱-适应', 8803: '潮汐监狱-绝密',
  8901: 'AZ3-普通', 8902: 'AZ3-机密', 8921: 'AZ3-老科学院', 8922: 'AZ3-核心反应堆', 8923: 'AZ3-压水堆',
};

// 同步时从官方配置读到的最新名称（汇总页启动时从本机数据库里取出来设进来），优先于快照
let armedOverride = {};
let mapsOverride = {};
export function setNameOverrides(names) {
  armedOverride = (names && names.armed) || {};
  mapsOverride = (names && names.maps) || {};
}
export const armedForceName = id => armedOverride[id] || ARMED_FORCES_SNAPSHOT[id] || `干员#${id}`;
export const mapName = id => mapsOverride[id] || MAPS_SNAPSHOT[id] || `地图#${id}`;
