import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import { parseMonthDay, parseTsuyosaForecast } from './tsuyosa-scraper';

const bossSection = (
  id: string,
  label: string,
  slug: string,
  cells: { date: string; icon: string; boss: string }[],
) => `
<div class="head-withinfo mt15" id="${id}">
  <span>${label}</span>
  <a href="/sc/public/playguide/${slug}" target="_blank"></a>
</div>
<div class="tokoyami-box mt10">
  <table class="tokoyami tokoyami-panigarm">
    <tr>
      <th width="16%">日付</th>
      ${cells.map((c) => `<th><span class="color_sun">${c.date}</span></th>`).join('')}
    </tr>
    <tr>
      <th>出現ボス<br>モンスター</th>
      ${cells
        .map(
          (c) =>
            `<td><img class="tokoyami-panigarm-icon" src="https://cache.hiroba.dqx.jp/dq_resource/img/tokoyami/${c.icon}?29727911"><div>${c.boss}</div></td>`,
        )
        .join('')}
    </tr>
  </table>
</div>`;

const FIXTURE = `<html><body>
${bossSection('bootcamp', 'ヴァリーブートキャンプ', 'guide_4_61', [
  { date: '07/05（日）', icon: 'vali/4.png', boss: '練武の鎧竜' },
  { date: '07/12（日）', icon: 'vali/0.png', boss: '練武の機神' },
  { date: '07/19（日）', icon: 'vali/1.png', boss: '練武の鋼殻' },
])}
${bossSection('panigarm', '源世庫パニガルム', 'guide_4_59', [
  { date: '07/11（土）', icon: 'panigarm/aaa.png', boss: '源世鳥アルマナ' },
  { date: '07/14（火）', icon: 'panigarm/bbb.png', boss: 'じげんりゅう' },
  { date: '07/17（金）', icon: 'panigarm/ccc.png', boss: '源世妃フォルダイナ' },
])}
</body></html>`;

const TODAY = Temporal.PlainDate.from('2026-07-01');

describe('parseTsuyosaForecast', () => {
  const forecast = parseTsuyosaForecast(FIXTURE, TODAY);

  it('parses the weekly boot camp rotation', () => {
    const b = forecast.bootcamp!;
    expect(b.content).toBe('bootcamp');
    expect(b.periodDays).toBe(7);
    expect(b.guideSlug).toBe('guide_4_61');
    expect(b.slots.map((s) => s.bossJa)).toEqual([
      '練武の鎧竜',
      '練武の機神',
      '練武の鋼殻',
    ]);
    expect(b.slots.map((s) => s.date.toString())).toEqual([
      '2026-07-05',
      '2026-07-12',
      '2026-07-19',
    ]);
    expect(b.slots[0].iconKey).toBe('4.png');
  });

  it('parses the 3-day panigarm rotation', () => {
    const p = forecast.panigarm!;
    expect(p.periodDays).toBe(3);
    expect(p.slots.map((s) => s.bossJa)).toEqual([
      '源世鳥アルマナ',
      'じげんりゅう',
      '源世妃フォルダイナ',
    ]);
    expect(p.slots.map((s) => s.date.toString())).toEqual([
      '2026-07-11',
      '2026-07-14',
      '2026-07-17',
    ]);
  });

  it('returns null for a missing section', () => {
    expect(parseTsuyosaForecast('<html></html>', TODAY).bootcamp).toBeNull();
  });
});

const ICON = (p: string) =>
  `https://cache.hiroba.dqx.jp/dq_resource/img/tokoyami/${p}?29727911`;

const ICON_FIXTURE = `<html><body>
<div class="head-withinfo" id="raid"><span>アストルティア防衛軍</span></div>
<div class="tokoyami-box">
  <table class="tokoyami-raid">
    <tr><th>日付</th><th>07/11(土)</th><th>07/12(日)</th></tr>
    <tr><td>6:00 ～ 6:59</td><td><img src="${ICON('raid/ico/12.png')}"></td><td><img src="${ICON('raid/ico/19.png')}"></td></tr>
    <tr><td>0:00 ～ 0:59</td><td><img src="${ICON('raid/ico/3.png')}"></td><td></td></tr>
  </table>
</div>
<div class="head-withinfo" id="togabito"><span>深淵の咎人たち</span></div>
<div class="tokoyami-box">
  <table class="tokoyami">
    <tr><th>日付</th><th>07/11(土)</th><th>07/12(日)</th></tr>
    <tr><td><img src="${ICON('togabito/aaa.png')}"></td><td><img src="${ICON('togabito/bbb.png')}"></td></tr>
    <tr><td><img src="${ICON('togabito/ccc.png')}"></td><td><img src="${ICON('togabito/ddd.png')}"></td></tr>
  </table>
</div>
<div class="head-withinfo" id="metal"><span>メタルーキー軍団</span></div>
<div class="tokoyami-box"><p class="notice-text">※サーバー09...</p></div>
<div class="tokoyami-box">
  <table class="tokoyami-raid">
    <tr><th>日付</th><th>07/11(土)</th><th>07/12(日)</th></tr>
    <tr><td>6:00 ～ 6:29</td><td><img src="${ICON('koushin/ico/1.png')}"></td><td></td></tr>
    <tr><td>6:30 ～ 6:59</td><td></td><td><img src="${ICON('koushin/ico/1.png')}"></td></tr>
  </table>
</div>
</body></html>`;

describe('parseTsuyosaForecast icon sections', () => {
  const f = parseTsuyosaForecast(ICON_FIXTURE, TODAY);

  it('parses hourly 防衛軍 icons, rolling 00:00–05:59 to the next day', () => {
    expect(f.defense).toHaveLength(3);
    const first = f.defense[0];
    expect(first.date.toString()).toBe('2026-07-11');
    expect(first.startMinute).toBe(360);
    expect(first.durationMinutes).toBe(60);
    expect(first.iconUrl).toBe(
      'https://cache.hiroba.dqx.jp/dq_resource/img/tokoyami/raid/ico/12.png',
    );
    // the 0:00 row under 07/11 rolls to 07/12
    const rolled = f.defense.find((s) => s.startMinute === 0);
    expect(rolled?.date.toString()).toBe('2026-07-12');
  });

  it('parses 深淵 boss icons per day (all cells)', () => {
    expect(f.abyss).toHaveLength(4);
    expect(f.abyss.map((s) => s.date.toString())).toEqual([
      '2026-07-11',
      '2026-07-12',
      '2026-07-11',
      '2026-07-12',
    ]);
  });

  it('parses メタルーキー half-hour markers from the later box', () => {
    expect(f.metal).toHaveLength(2);
    expect(f.metal[0].durationMinutes).toBe(30);
    expect(f.metal.map((s) => s.startMinute).sort((a, b) => a - b)).toEqual([
      360, 390,
    ]);
  });
});

describe('parseMonthDay year inference', () => {
  it('keeps the current year for a near date', () => {
    expect(parseMonthDay('07/11(土)', TODAY)?.toString()).toBe('2026-07-11');
  });
  it('rolls forward across the December→January boundary', () => {
    const dec = Temporal.PlainDate.from('2026-12-20');
    expect(parseMonthDay('01/03(土)', dec)?.toString()).toBe('2027-01-03');
  });
  it('rolls back for a December date seen in early January', () => {
    const jan = Temporal.PlainDate.from('2026-01-05');
    expect(parseMonthDay('12/28(月)', jan)?.toString()).toBe('2025-12-28');
  });
  it('returns null for unparseable text', () => {
    expect(parseMonthDay('日付', TODAY)).toBeNull();
  });
});
