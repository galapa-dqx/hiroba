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
