/** @typedef {'pro' | 'guild'} TeamKind */

export const TEAMS = {
  jiashi: {
    id: 'jiashi', name: '嘉世战队', city: 'H市（杭州）', abbr: '嘉世', kind: 'pro',
    color: '#c0392b', colorLight: '#e74c3c', textColor: '#fff',
    icon: '🍁', badge: '枫叶',
    style: '曾经的王朝战队，三连冠缔造者。以叶修为核心的攻防一体打法。',
    achievements: ['S1冠军', 'S2冠军', 'S3冠军'],
    uniform: '红白', founded: 'S1',
  },
  batu: {
    id: 'batu', name: '霸图战队', city: 'Q市（青岛）', abbr: '霸图', fanNick: '82', kind: 'pro',
    color: '#2c3e50', colorLight: '#c0392b', textColor: '#fff',
    icon: '🔥', badge: '铁拳',
    style: '十年如一日勇往直前，强硬对抗。正面击溃对手为信条。',
    achievements: ['S4冠军'],
    uniform: '红黑', founded: 'S1',
  },
  lanyu: {
    id: 'lanyu', name: '蓝雨战队', city: 'G市（广州）', abbr: '蓝雨', fanNick: '庙', kind: 'pro',
    color: '#2980b9', colorLight: '#3498db', textColor: '#fff',
    icon: '⚔️', badge: '剑与六芒星',
    style: '机会主义战队。喻文州战术布局+黄少天致命一击的"剑与诅咒"组合。',
    achievements: ['S6冠军'],
    uniform: '蓝白', founded: 'S1',
  },
  weicao: {
    id: 'weicao', name: '微草战队', city: 'B市（北京）', abbr: '微草', fanNick: '药', kind: 'pro',
    color: '#27ae60', colorLight: '#2ecc71', textColor: '#fff',
    icon: '🌿', badge: '绿色草叶',
    style: '围绕王杰希的"魔术师"打法，风格诡异多变。账号卡全部是中草药名。',
    achievements: ['S5冠军', 'S7冠军'],
    uniform: '绿白', founded: 'S1',
  },
  lunhui: {
    id: 'lunhui', name: '轮回战队', city: 'S市（上海）', abbr: '轮回', kind: 'pro',
    color: '#2c3e50', colorLight: '#7f8c8d', textColor: '#fff',
    icon: '🎯', badge: '子弹',
    style: '围绕周泽楷的精准打法，后发展为双核三核驱动。',
    achievements: ['S8冠军', 'S9冠军'],
    uniform: '黑白', founded: 'S4',
  },
  baihua: {
    id: 'baihua', name: '百花战队', city: 'K市（昆明）', abbr: '百花', kind: 'pro',
    color: '#e91e63', colorLight: '#f48fb1', textColor: '#fff',
    icon: '🌸', badge: '花瓣',
    style: '以双花闻名（落花狼籍与百花缭乱），华丽的攻击型打法。',
    achievements: ['S3亚军', 'S5亚军', 'S7亚军'],
    uniform: '粉色', founded: 'S2',
  },
  huxiao: {
    id: 'huxiao', name: '呼啸战队', city: 'N市（南京）', abbr: '呼啸', kind: 'pro',
    color: '#f39c12', colorLight: '#f1c40f', textColor: '#fff',
    icon: '🌪️', badge: '风暴',
    style: '林敬言时代的猥琐流犯罪组合，唐昊时代转为强硬进攻。',
    achievements: [],
    uniform: '黄白', founded: 'S2',
  },
  xukong: {
    id: 'xukong', name: '虚空战队', city: 'X市（西安）', abbr: '虚空', kind: 'pro',
    color: '#9b59b6', colorLight: '#8e44ad', textColor: '#fff',
    icon: '👻', badge: '鬼魂',
    style: '双鬼拍阵，李轩与吴羽策的鬼剑士搭档，缺乏攻坚手。',
    achievements: [],
    uniform: '紫白', founded: 'S2',
  },
  leiting: {
    id: 'leiting', name: '雷霆战队', city: '未知', abbr: '雷霆', kind: 'pro',
    color: '#6c3483', colorLight: '#8e44ad', textColor: '#fff',
    icon: '⚡', badge: '闪电',
    style: '以机械师肖时钦为核心的技术型战队。',
    achievements: [],
    uniform: '蓝紫', founded: 'S1',
  },
  huangfeng: {
    id: 'huangfeng', name: '皇风战队', city: '未知', abbr: '皇风', kind: 'pro',
    color: '#d4ac0d', colorLight: '#f1c40f', textColor: '#fff',
    icon: '👑', badge: '皇冠',
    style: '初代豪门，影子战术开创者。祖上阔过。',
    achievements: ['S1亚军'],
    uniform: '金色', founded: 'S1',
  },
  yanyu: {
    id: 'yanyu', name: '烟雨战队', city: '未知', abbr: '烟雨', kind: 'pro',
    color: '#1abc9c', colorLight: '#48c9b0', textColor: '#fff',
    icon: '🌧️', badge: '烟雨',
    style: '以楚云秀为核心的元素法师战队。',
    achievements: [],
    uniform: '青白', founded: 'S1',
  },
  sanlingyi: {
    id: 'sanlingyi', name: '三零一战队', city: '未知', abbr: '三零一', fanNick: '301', kind: 'pro',
    color: '#34495e', colorLight: '#5d6d7e', textColor: '#fff',
    icon: '🛡️', badge: '盾牌',
    style: '稳健防守型战队。',
    achievements: [],
    uniform: '灰色', founded: 'S2',
  },
  xingxin: {
    id: 'xingxin', name: '兴欣战队', city: 'H市（杭州）', abbr: '兴欣', kind: 'pro',
    color: '#e67e22', colorLight: '#f39c12', textColor: '#fff',
    icon: '⭐', badge: '星辰',
    style: '叶修组建的草根战队，黑马奇迹缔造者。升班马直接夺冠。',
    achievements: ['S10冠军'],
    uniform: '橙色', founded: 'S9',
  },
  yizhan: {
    id: 'yizhan', name: '义斩战队', city: 'B市（北京）', abbr: '义斩', kind: 'pro',
    color: '#c0392b', colorLight: '#e74c3c', textColor: '#fff',
    icon: '⚔️', badge: '斩刀',
    style: '携资入局的新战队。',
    achievements: [],
    uniform: '红色', founded: 'S10',
  },
  shenqi: {
    id: 'shenqi', name: '神奇战队', city: 'M市', abbr: '神奇', kind: 'pro',
    color: '#8e44ad', colorLight: '#9b59b6', textColor: '#fff',
    icon: '✨', badge: '魔方',
    style: '第十赛季新入联盟的战队，接收了原嘉世的几名选手。',
    achievements: [],
    uniform: '紫色', founded: 'S10',
  },
  lanxige: {
    id: 'lanxige', name: '蓝溪阁', city: 'G市', abbr: '蓝溪阁', kind: 'guild',
    color: '#2980b9', colorLight: '#3498db', textColor: '#fff',
    icon: '🛡️', badge: '蓝溪阁',
    style: '蓝雨战队下属公会。',
    achievements: [],
    uniform: '蓝色', founded: 'S1',
  },
  zhongcaotang: {
    id: 'zhongcaotang', name: '中草堂', city: 'B市', abbr: '中草堂', kind: 'guild',
    color: '#27ae60', colorLight: '#2ecc71', textColor: '#fff',
    icon: '🌿', badge: '中草堂',
    style: '微草战队下属公会。',
    achievements: [],
    uniform: '绿色', founded: 'S1',
  },
  baqixiongtu: {
    id: 'baqixiongtu', name: '霸气雄图', city: 'Q市', abbr: '霸气雄图', kind: 'guild',
    color: '#2c3e50', colorLight: '#c0392b', textColor: '#fff',
    icon: '🔥', badge: '霸气雄图',
    style: '霸图战队下属公会。',
    achievements: [],
    uniform: '红黑', founded: 'S1',
  },
  yanyulou: {
    id: 'yanyulou', name: '烟雨楼', city: '未知', abbr: '烟雨楼', kind: 'guild',
    color: '#1abc9c', colorLight: '#48c9b0', textColor: '#fff',
    icon: '🌧️', badge: '烟雨楼',
    style: '烟雨战队下属公会。',
    achievements: [],
    uniform: '青色', founded: 'S1',
  },
  baihuagu: {
    id: 'baihuagu', name: '百花谷', city: 'K市', abbr: '百花谷', kind: 'guild',
    color: '#e91e63', colorLight: '#f48fb1', textColor: '#fff',
    icon: '🌸', badge: '百花谷',
    style: '百花战队下属公会。',
    achievements: [],
    uniform: '粉色', founded: 'S2',
  },
  lunhuigonghui: {
    id: 'lunhuigonghui', name: '轮回公会', city: 'S市', abbr: '轮回公会', kind: 'guild',
    color: '#2c3e50', colorLight: '#7f8c8d', textColor: '#fff',
    icon: '🎯', badge: '轮回公会',
    style: '轮回战队下属公会。',
    achievements: [],
    uniform: '黑白', founded: 'S4',
  },
  xingxingonghui: {
    id: 'xingxingonghui', name: '兴欣公会', city: 'H市', abbr: '兴欣公会', kind: 'guild',
    color: '#e67e22', colorLight: '#f39c12', textColor: '#fff',
    icon: '⭐', badge: '兴欣公会',
    style: '兴欣战队下属公会。',
    achievements: [],
    uniform: '橙色', founded: 'S10',
  },
};

export const TEAM_LIST = Object.values(TEAMS);

function foundedIndexForSchedule(founded) {
  const m = String(founded || 'S1').match(/^S(\d+)$/i);
  return m ? parseInt(m[1], 10) : 1;
}

/** 联赛单循环赛程：仅职业战队，不含网游公会；按成立赛季过滤 */
export function teamsEligibleForSchedule(seasonId) {
  const pro = TEAM_LIST.filter((t) => t.kind === 'pro');
  if (seasonId === 'S0') {
    return pro.filter((t) => foundedIndexForSchedule(t.founded) <= 1);
  }
  const num = parseInt(String(seasonId).replace(/\D/g, ''), 10) || 1;
  return pro.filter((t) => foundedIndexForSchedule(t.founded) <= num);
}

export function getTeamById(id) {
  return TEAMS[id];
}
