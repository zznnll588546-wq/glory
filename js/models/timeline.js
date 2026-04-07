export const SEASONS = [
  { id: 'S0', name: '联赛成立前', year: '2012-2015', description: '荣耀发行，苏沐秋身亡，职业联盟成立前夕' },
  { id: 'S1', name: '第一赛季', year: '2015夏-2016春', champion: '嘉世', description: '嘉世王朝开端，叶修首冠' },
  { id: 'S2', name: '第二赛季', year: '2016夏-2017春', champion: '嘉世', description: '嘉世卫冕，繁花血景成型，魏琛退役' },
  { id: 'S3', name: '第三赛季', year: '2017夏-2018春', champion: '嘉世', description: '嘉世三连冠，王杰希出道无新人墙，首届全明星' },
  { id: 'S4', name: '第四赛季', year: '2018夏-2019春', champion: '霸图', description: '黄金一代出道，霸图终结嘉世王朝' },
  { id: 'S5', name: '第五赛季', year: '2019夏-2020春', champion: '微草', description: '微草首冠，孙哲平手伤退役，周泽楷最佳新人' },
  { id: 'S6', name: '第六赛季', year: '2020夏-2021春', champion: '蓝雨', description: '蓝雨夺冠，剑与诅咒，药庙之争' },
  { id: 'S7', name: '第七赛季', year: '2021夏-2022春', champion: '微草', description: '微草双冠，张佳乐方士谦退役，七期生出道' },
  { id: 'S8', name: '第八赛季', year: '2022夏-2023春', champion: '轮回', description: '叶修退役蛰伏，嘉世降级，转会大地震' },
  { id: 'S9', name: '第九赛季', year: '2023夏-2024春', champion: '轮回', description: '兴欣挑战赛，轮回卫冕，75级开放' },
  { id: 'S10', name: '第十赛季', year: '2024夏-2025春', champion: '兴欣', description: '兴欣黑马奇迹夺冠，叶修37连胜' },
  { id: 'S11', name: '第十一赛季', year: '2025秋起', champion: '未知', description: '嘉世重返联盟，世邀赛后新格局' },
];

export function getSeasonInfo(seasonId) {
  return SEASONS.find(s => s.id === seasonId);
}

export function getSeasonYear(seasonId) {
  const s = getSeasonInfo(seasonId);
  return s ? s.year : '';
}
