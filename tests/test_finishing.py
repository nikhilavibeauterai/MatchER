"""Colour wheels, editable brush masks and straightening survive history and reach only edited exports."""
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from matcher import finishing, touchup
from tests.test_edits import client
from tests.test_game_flow import play_duels, post


def test_finishing_is_one_atomic_undoable_edit(client):
    play_duels(client, 2)
    pid = client.get('/api/shortlist').get_json()['items'][0]['photo']
    patch = {'grade': {'shadows': {'hue': 220, 'amount': .4}}, 'straighten': -3.125,
             'masks': [{'id': 'deer', 'name': 'Deer', 'adjust': {'exposure': .6},
                        'strokes': [{'mode': 'paint', 'r': .08, 'p': [[.3, .4], [.5, .6]]}]}]}
    r = post(client, '/api/edit', {'photo': pid, **patch}).get_json()
    assert r['undo'] == 'edit' and r['edits']['straighten'] == -3.125
    assert r['edits']['masks'][0]['opacity'] == 1
    read = lambda: client.get(f'/api/edit?photo={pid}').get_json()['edits']
    saved = read()
    post(client, '/api/draw/undo')
    assert read() == {}
    post(client, '/api/draw/redo')
    assert read() == saved
    for bad in ({'straighten': True}, {'straighten': 46}, {'grade': {'magic': .5}},
                {'grade': {'midtones': {'amount': float('nan')}}}, {'masks': 'all'},
                {'masks': [{'id': 'a', 'adjust': {'exposure': 20}}]},
                {'masks': [{'id': 'a', 'strokes': [{'mode': 'paint', 'r': .1, 'p': [[-1, .5]]}]}]}):
        assert post(client, '/api/edit', {'photo': pid, **bad}).status_code == 400
        assert read() == saved
    assert post(client, '/api/edit', {'photo': pid, 'grade': None, 'masks': [], 'straighten': 0}).get_json()['edits'] == {}


def test_colour_curves_match_the_browser_and_identity_is_exact():
    grade = {'shadows': {'hue': 215, 'amount': .6, 'light': -.1}, 'midtones': {'hue': 36, 'amount': .25},
             'highlights': {'hue': 60, 'amount': .3, 'light': .2}, 'blending': .6, 'balance': -.2}
    js = "const {PhotoFinish:p}=require('./matcher/static/photo-finish.js');process.stdout.write(JSON.stringify(p.tables(JSON.parse(process.argv[1]))));"
    browser = np.array(json.loads(subprocess.check_output(['node', '-e', js, json.dumps(grade)], cwd=Path(__file__).parents[1]))).T
    assert np.max(np.abs(browser - finishing.grade_table(grade))) < 1e-12
    assert np.array_equal(np.round(finishing.grade_table(None) * 255), np.tile(np.arange(256)[:, None], (1, 3)))


@pytest.mark.parametrize('turn', [0, 90, 180, 270])
def test_brush_erase_crop_and_turn_reach_the_same_pixels(tmp_path, turn):
    im = Image.new('RGB', (400, 300), (70, 90, 110))
    src, dst = tmp_path / 'source.png', tmp_path / 'edited.jpg'
    im.save(src)
    before = src.read_bytes()
    layer = {'id': 'light', 'enabled': True, 'opacity': 1, 'feather': 0, 'adjust': {'exposure': 1},
             'strokes': [{'mode': 'paint', 'r': .18, 'p': [[.35, .5], [.65, .5]]},
                         {'mode': 'erase', 'r': .05, 'p': [[.5, .5]]}]}
    out = finishing.apply(im, {'masks': [layer]}, im.size, (0, 0, 400, 300))
    assert out.getpixel((140, 150)) == (140, 180, 220)
    assert out.getpixel((200, 150)) == im.getpixel((200, 150))
    assert out.getpixel((10, 10)) == im.getpixel((10, 10))
    touchup.touch_up(src, dst, {'enhance': False, 'crop': 'custom', 'crop_box': [.2, .2, .6, .6], 'rotate': turn, 'masks': [layer]})
    expected = out.crop((80, 60, 320, 240))
    if turn:
        expected = expected.transpose(touchup.TURNS[turn])
    actual = np.asarray(Image.open(dst)).astype(float)
    assert actual.shape == np.asarray(expected).shape
    assert np.abs(actual - np.asarray(expected)).mean() < 2
    assert src.read_bytes() == before


def test_feather_opacity_and_layer_enable_are_editable():
    layer = {'id': 'a', 'opacity': .5, 'feather': 1, 'adjust': {'exposure': 1},
             'strokes': [{'mode': 'paint', 'r': .2, 'p': [[.5, .5]]}]}
    im = Image.new('RGB', (300, 300), (80, 80, 80))
    mask = np.asarray(finishing.mask_image(layer, im.size))
    assert ((mask > 0) & (mask < 255)).any()
    out = finishing.apply(im, {'masks': [layer]}, im.size, (0, 0, 300, 300))
    assert out.getpixel((150, 150)) == (120, 120, 120)
    layer['enabled'] = False
    assert np.array_equal(finishing.apply(im, {'masks': [layer]}, im.size, (0, 0, 300, 300)), im)


@pytest.mark.parametrize('angle', [-45, -12.345, 3.125, 45])
def test_straightening_trims_corners_and_preserves_aspect_ratio(angle):
    im = Image.new('RGB', (600, 400), (100, 140, 180))
    out = finishing.straighten(im, angle)
    assert abs(out.width / out.height - 1.5) < .01
    assert out.width < im.width and out.height < im.height
    assert np.max(np.abs(np.asarray(out).astype(int) - [100, 140, 180])) <= 1


def test_grade_and_straighten_are_baked_in_without_enhance(tmp_path):
    src, dst = tmp_path / 'source.png', tmp_path / 'edited.jpg'
    Image.new('RGB', (600, 400), (100, 100, 100)).save(src)
    before = src.read_bytes()
    touchup.touch_up(src, dst, {'enhance': False, 'grade': {'midtones': {'hue': 0, 'amount': 1}}, 'straighten': 5})
    with Image.open(dst) as out:
        r, g, b = out.getpixel((out.width // 2, out.height // 2))
        assert r > g + 20 and r > b + 20 and out.size != (600, 400)
    assert src.read_bytes() == before
