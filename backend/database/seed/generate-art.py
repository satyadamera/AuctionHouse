"""
Generates the original product illustrations used by the demo seed (backend/assets/seed/*.svg).
They are drawn from simple shapes so the repo carries no third-party imagery and no licensing risk,
and so the demo works fully offline. Re-run with: python3 backend/database/seed/generate-art.py
"""
import os, math
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'seed')
os.makedirs(OUT, exist_ok=True)

def frame(bg, body, shadow_w=260, shadow_y=650):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" width="800" height="800">
<defs>
<radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="{bg[0]}"/><stop offset="1" stop-color="{bg[1]}"/></radialGradient>
<radialGradient id="sh" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f4f2"/><stop offset=".5" stop-color="#b9bcbd"/><stop offset="1" stop-color="#7d8285"/></linearGradient>
<linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3dc9b"/><stop offset=".55" stop-color="#c49a45"/><stop offset="1" stop-color="#8a6526"/></linearGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<rect width="800" height="800" fill="url(#bg)"/>
<ellipse cx="400" cy="{shadow_y}" rx="{shadow_w}" ry="34" fill="url(#sh)"/>
{body}
</svg>'''

def ticks(cx, cy, r, n=60, major=5, col="#2a2d2e"):
    s=[]
    for i in range(n):
        a=2*math.pi*i/n; l=18 if i%major==0 else 8; w=4 if i%major==0 else 1.5
        x1=cx+math.sin(a)*r; y1=cy-math.cos(a)*r; x2=cx+math.sin(a)*(r-l); y2=cy-math.cos(a)*(r-l)
        s.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{col}" stroke-width="{w}" stroke-linecap="round"/>')
    return ''.join(s)

def hand(cx,cy,ang,length,w,col):
    a=math.radians(ang); x=cx+math.sin(a)*length; y=cy-math.cos(a)*length
    return f'<line x1="{cx}" y1="{cy}" x2="{x:.1f}" y2="{y:.1f}" stroke="{col}" stroke-width="{w}" stroke-linecap="round"/>'

def watch(dial, case='url(#metal)', strap='#3b2a20', bezel=None, sub=False, lume='#2a2d2e'):
    b=f'<circle cx="400" cy="380" r="188" fill="{bezel}"/>' + ''.join(f'<rect x="397" y="196" width="6" height="14" fill="#e8e8e8" transform="rotate({i*30} 400 380)"/>' for i in range(12)) if bezel else ''
    subs=''
    if sub:
        for dx,dy in [(-62,10),(62,10),(0,72)]:
            subs+=f'<circle cx="{400+dx}" cy="{380+dy}" r="34" fill="none" stroke="{lume}" stroke-opacity=".5" stroke-width="2"/>'+hand(400+dx,380+dy,40+dx,26,3,lume)
    return (f'<rect x="330" y="80" width="140" height="160" rx="26" fill="{strap}"/><rect x="330" y="520" width="140" height="190" rx="26" fill="{strap}"/>'
            f'<circle cx="400" cy="380" r="205" fill="{case}"/>{b}<circle cx="400" cy="380" r="160" fill="{dial}"/>'
            f'{ticks(400,380,150,col=lume)}{subs}<rect x="586" y="362" width="34" height="36" rx="8" fill="{case}"/>'
            f'{hand(400,380,305,92,9,lume)}{hand(400,380,62,128,6,lume)}{hand(400,380,170,138,2,"#b3432f")}'
            f'<circle cx="400" cy="380" r="10" fill="{lume}"/><circle cx="400" cy="380" r="160" fill="url(#gloss)"/>')

def headphones(c1,c2):
    return (f'<path d="M210 470 C210 190 590 190 590 470" fill="none" stroke="{c1}" stroke-width="46" stroke-linecap="round"/>'
            f'<path d="M230 455 C230 230 570 230 570 455" fill="none" stroke="{c2}" stroke-width="12" stroke-linecap="round" opacity=".6"/>'
            f'<rect x="150" y="410" width="130" height="200" rx="58" fill="{c1}"/><rect x="520" y="410" width="130" height="200" rx="58" fill="{c1}"/>'
            f'<rect x="250" y="430" width="44" height="160" rx="22" fill="{c2}"/><rect x="506" y="430" width="44" height="160" rx="22" fill="{c2}"/>'
            f'<rect x="150" y="410" width="130" height="200" rx="58" fill="url(#gloss)"/><rect x="520" y="410" width="130" height="200" rx="58" fill="url(#gloss)"/>')

def camera(body, trim):
    return (f'<rect x="150" y="270" width="500" height="300" rx="34" fill="{body}"/><rect x="150" y="270" width="500" height="80" rx="34" fill="url(#metal)"/>'
            f'<rect x="150" y="320" width="500" height="200" fill="{trim}"/><rect x="200" y="230" width="90" height="50" rx="10" fill="url(#metal)"/>'
            f'<rect x="520" y="292" width="90" height="40" rx="6" fill="#2b3a40"/><circle cx="400" cy="440" r="128" fill="url(#metal)"/>'
            f'<circle cx="400" cy="440" r="100" fill="#151819"/><circle cx="400" cy="440" r="64" fill="#24343c"/><circle cx="378" cy="418" r="18" fill="#fff" opacity=".35"/>'
            f'<circle cx="590" cy="250" r="22" fill="url(#metal)"/>')

def turntable(plinth, rec):
    return (f'<rect x="130" y="250" width="540" height="390" rx="22" fill="{plinth}"/><rect x="130" y="590" width="540" height="50" rx="10" fill="#000" opacity=".15"/>'
            f'<circle cx="360" cy="430" r="165" fill="#111"/>' + ''.join(f'<circle cx="360" cy="430" r="{r}" fill="none" stroke="#2c2c2c" stroke-width="1.5"/>' for r in range(70,160,9)) +
            f'<circle cx="360" cy="430" r="58" fill="{rec}"/><circle cx="360" cy="430" r="7" fill="#ddd"/>'
            f'<circle cx="590" cy="300" r="26" fill="url(#metal)"/><path d="M590 300 L600 520 L520 560" fill="none" stroke="url(#metal)" stroke-width="10" stroke-linecap="round"/>'
            f'<rect x="595" y="580" width="40" height="18" rx="4" fill="url(#metal)"/>')

def gamepad(c1,c2):
    return (f'<path d="M230 330 Q400 290 570 330 Q680 350 690 520 Q700 620 620 610 Q560 600 520 520 L280 520 Q240 600 180 610 Q100 620 110 520 Q120 350 230 330Z" fill="{c1}"/>'
            f'<rect x="215" y="395" width="110" height="34" rx="8" fill="{c2}"/><rect x="253" y="357" width="34" height="110" rx="8" fill="{c2}"/>'
            + ''.join(f'<circle cx="{x}" cy="{y}" r="20" fill="{c}"/>' for x,y,c in [(555,370,"#e0b84a"),(595,410,"#c9533f"),(515,410,"#3f7cc9"),(555,450,"#4aa36b")]) +
            f'<circle cx="335" cy="480" r="40" fill="#222"/><circle cx="465" cy="480" r="40" fill="#222"/><path d="M230 330 Q400 290 570 330 L560 360 Q400 330 240 360Z" fill="#fff" opacity=".18"/>')

def keyboard(c1,keys,accent):
    k=''
    for row in range(5):
        for col in range(12):
            col_ = accent if (row==0 and col==0) or (row==4 and col in (4,5,6)) else keys
            if row==4 and col in (5,6): continue
            w = 120 if (row==4 and col==4) else 38
            k+=f'<rect x="{150+col*42}" y="{330+row*44}" width="{w}" height="38" rx="7" fill="{col_}"/><rect x="{154+col*42}" y="{332+row*44}" width="{w-8}" height="26" rx="5" fill="#fff" opacity=".18"/>'
    return f'<rect x="130" y="310" width="540" height="250" rx="24" fill="{c1}"/>{k}'

def phone(c1):
    return (f'<rect x="270" y="130" width="260" height="520" rx="44" fill="{c1}"/><rect x="284" y="146" width="232" height="488" rx="32" fill="#10161a"/>'
            f'<rect x="300" y="190" width="200" height="300" rx="10" fill="#1f4d3f"/><circle cx="400" cy="560" r="28" fill="none" stroke="#2a3238" stroke-width="4"/>'
            f'<rect x="370" y="160" width="60" height="8" rx="4" fill="#2a3238"/><rect x="300" y="190" width="200" height="140" fill="url(#gloss)"/>')

def canvas(shapes, frame_col='#2b2b2b', w=420, h=520):
    x=400-w/2; y=360-h/2
    return (f'<rect x="{x-22}" y="{y-22}" width="{w+44}" height="{h+44}" fill="{frame_col}"/><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#f2efe6"/>'
            f'<g transform="translate({x} {y})">{shapes}</g>')

def coin(metal, emb):
    return (f'<circle cx="400" cy="400" r="210" fill="{metal}"/><circle cx="400" cy="400" r="180" fill="none" stroke="#000" stroke-opacity=".15" stroke-width="6"/>'
            + ''.join(f'<circle cx="{400+math.sin(2*math.pi*i/48)*196:.1f}" cy="{400-math.cos(2*math.pi*i/48)*196:.1f}" r="4" fill="#000" opacity=".12"/>' for i in range(48)) +
            f'{emb}<circle cx="400" cy="400" r="210" fill="url(#gloss)"/>')

def card(c1,c2):
    return (f'<g transform="rotate(-6 400 380)"><rect x="250" y="140" width="300" height="440" rx="18" fill="#f4f1e6" stroke="#c9c2a7" stroke-width="6"/>'
            f'<rect x="275" y="170" width="250" height="250" rx="8" fill="{c1}"/><circle cx="400" cy="300" r="70" fill="{c2}"/><path d="M330 420 Q400 320 470 420Z" fill="{c2}" opacity=".7"/>'
            f'<rect x="275" y="440" width="180" height="18" rx="4" fill="#3a3a3a"/><rect x="275" y="472" width="250" height="10" rx="4" fill="#9a9a90"/><rect x="275" y="492" width="200" height="10" rx="4" fill="#9a9a90"/>'
            f'<circle cx="500" cy="540" r="22" fill="url(#gold)"/><rect x="250" y="140" width="300" height="200" rx="18" fill="url(#gloss)"/></g>')

def robot(c1,c2):
    return (f'<rect x="300" y="170" width="200" height="160" rx="18" fill="{c1}"/><rect x="330" y="215" width="140" height="60" rx="8" fill="#20282c"/>'
            f'<circle cx="370" cy="245" r="14" fill="#e0b84a"/><circle cx="430" cy="245" r="14" fill="#e0b84a"/><line x1="400" y1="170" x2="400" y2="130" stroke="{c2}" stroke-width="8"/><circle cx="400" cy="124" r="12" fill="#c9533f"/>'
            f'<rect x="280" y="345" width="240" height="210" rx="16" fill="{c1}"/><rect x="320" y="380" width="160" height="90" rx="8" fill="{c2}"/>'
            + ''.join(f'<circle cx="{340+i*30}" cy="500" r="9" fill="#c9533f"/>' for i in range(5)) +
            f'<rect x="230" y="360" width="40" height="150" rx="16" fill="{c2}"/><rect x="530" y="360" width="40" height="150" rx="16" fill="{c2}"/>'
            f'<rect x="310" y="555" width="60" height="90" rx="10" fill="{c2}"/><rect x="430" y="555" width="60" height="90" rx="10" fill="{c2}"/><rect x="300" y="170" width="200" height="70" rx="18" fill="url(#gloss)"/>')

def pen(barrel):
    return (f'<g transform="rotate(-35 400 400)"><rect x="370" y="120" width="60" height="330" rx="28" fill="{barrel}"/><rect x="370" y="120" width="60" height="330" rx="28" fill="url(#gloss)"/>'
            f'<rect x="368" y="430" width="64" height="26" fill="url(#gold)"/><path d="M372 456 L428 456 L414 600 Q400 640 386 600Z" fill="#202020"/>'
            f'<path d="M386 560 L414 560 L404 680 L400 700 L396 680Z" fill="url(#gold)"/><line x1="400" y1="600" x2="400" y2="690" stroke="#6b4f1e" stroke-width="2"/>'
            f'<rect x="420" y="150" width="14" height="200" rx="6" fill="url(#gold)"/></g>')

def vase(c1,c2):
    return (f'<path d="M340 170 L460 170 L450 230 Q600 330 560 500 Q530 630 400 640 Q270 630 240 500 Q200 330 350 230Z" fill="{c1}"/>'
            f'<path d="M262 420 Q400 380 538 420 L540 460 Q400 420 260 460Z" fill="{c2}"/><path d="M280 520 Q400 490 520 520 L515 545 Q400 515 285 545Z" fill="{c2}"/>'
            f'<path d="M340 170 L460 170 L450 230 Q600 330 560 500 L520 480 Q540 330 420 240Z" fill="#fff" opacity=".12"/>')

def sculpture(c1):
    return (f'<rect x="300" y="560" width="200" height="80" fill="#d6d3cb"/><rect x="300" y="560" width="200" height="14" fill="#fff" opacity=".4"/>'
            f'<path d="M400 160 Q520 240 470 360 Q430 450 500 560 L300 560 Q380 450 330 360 Q280 230 400 160Z" fill="{c1}"/>'
            f'<ellipse cx="410" cy="330" rx="40" ry="70" fill="#000" opacity=".25"/><path d="M400 160 Q520 240 470 360 L440 340 Q480 240 400 170Z" fill="#fff" opacity=".2"/>')

def sneaker(upper, sole, accent, high=False):
    top = 'M190 470 L230 290 L330 280 Q360 340 420 360 L560 420 Q650 450 640 520 L190 520Z' if high else 'M170 470 Q190 360 300 360 Q360 390 430 395 L560 430 Q650 455 645 520 L170 520Z'
    return (f'<path d="{top}" fill="{upper}"/><path d="M160 520 L655 520 Q665 580 610 590 L190 590 Q150 585 160 520Z" fill="{sole}"/>'
            f'<path d="M160 545 L660 545" stroke="#000" stroke-opacity=".12" stroke-width="6"/>'
            f'<path d="M300 470 Q400 400 520 470" fill="none" stroke="{accent}" stroke-width="26" stroke-linecap="round"/>'
            + ''.join(f'<line x1="{340+i*34}" y1="{390+i*8 if not high else 340+i*14}" x2="{360+i*34}" y2="{420+i*8 if not high else 380+i*14}" stroke="#f5f5f5" stroke-width="6" stroke-linecap="round"/>' for i in range(4)) +
            f'<path d="{top}" fill="url(#gloss)"/>')

BG = {
 'sage':('#e6ebe4','#b9c6b9'),'sand':('#efe9df','#cfc3ae'),'slate':('#e3e7eb','#aeb8c2'),'blush':('#f1e6e3','#d3b8b0'),
 'mist':('#eceeed','#c2c7c5'),'ink':('#3a4248','#1d2226'),'olive':('#e9e8da','#bdbb98'),'sky':('#e4ecf1','#a9bfcc'),
}

art = {
 'watch-chronograph': (BG['slate'], watch('#f2f1ec', sub=True)),
 'watch-diver':       (BG['sky'],   watch('#1d2a33', bezel='#13355a', lume='#e9ecef', strap='#2a2f33')),
 'watch-dress':       (BG['sand'],  watch('#f4ecd8', case='url(#gold)', strap='#5a3423')),
 'watch-field':       (BG['olive'], watch('#2d3a2c', lume='#eae6d2', strap='#6a5a3a')),
 'headphones':        (BG['mist'],  headphones('#2f3437','#c9a46a')),
 'camera-rangefinder':(BG['sand'],  camera('#1d1f20','#2c2c2c')),
 'turntable':         (BG['blush'], turntable('#7a4f32','#b3432f')),
 'gamepad':           (BG['sky'],   gamepad('#e8e6e0','#3a3d40')),
 'keyboard':          (BG['sage'],  keyboard('#3a4146','#e9e6dd','#b8913a')),
 'phone-prototype':   (BG['slate'], phone('#c7ccd0')),
 'art-color-fields':  (BG['mist'],  canvas('<rect x="30" y="30" width="360" height="200" fill="#b3432f"/><rect x="30" y="250" width="360" height="110" fill="#1f4d3f"/><rect x="30" y="380" width="360" height="110" fill="#d9b25c"/>')),
 'art-circles':       (BG['sand'],  canvas('<circle cx="150" cy="180" r="110" fill="#1f4d3f"/><circle cx="270" cy="300" r="90" fill="#d9b25c" opacity=".9"/><circle cx="170" cy="380" r="60" fill="#b3432f"/><line x1="40" y1="470" x2="380" y2="470" stroke="#1a1f1c" stroke-width="6"/>', frame_col='#8a6526')),
 'art-landscape':     (BG['ink'],   canvas('<rect width="420" height="300" fill="#cfd9d6"/><circle cx="300" cy="110" r="44" fill="#e9c77b"/><path d="M0 300 L120 160 L210 260 L300 150 L420 300Z" fill="#4c6b5f"/><rect y="300" width="420" height="220" fill="#7b8f6a"/><path d="M0 400 Q210 340 420 410 L420 520 L0 520Z" fill="#53664a"/>', frame_col='#d9d4c7')),
 'art-sculpture':     (BG['slate'], sculpture('#2b2f31')),
 'coin-gold':         (BG['ink'],   coin('url(#gold)', '<text x="400" y="430" text-anchor="middle" font-family="Georgia, serif" font-size="110" fill="#6b4f1e" opacity=".75">1888</text>')),
 'coin-silver':       (BG['mist'],  coin('url(#metal)', '<path d="M330 470 Q400 260 470 470Z" fill="#555" opacity=".5"/><circle cx="400" cy="330" r="40" fill="#555" opacity=".45"/>')),
 'trading-card':      (BG['blush'], card('#3f6f8f','#e0b84a')),
 'tin-robot':         (BG['sky'],   robot('#c9533f','#8f9aa1')),
 'fountain-pen':      (BG['sand'],  pen('#1f4d3f')),
 'studio-vase':       (BG['sage'],  vase('#2f5f7a','#e8e2d0')),
 'sneaker-low-white': (BG['mist'],  sneaker('#f2f2ef','#e3d7c0','#1f4d3f')),
 'sneaker-high-red':  (BG['sand'],  sneaker('#b3432f','#f1ece2','#1a1f1c', high=True)),
 'sneaker-runner':    (BG['sky'],   sneaker('#5d6f7e','#f4f4f2','#e0b84a')),
}

for name,(bg,body) in art.items():
    with open(os.path.join(OUT, f'{name}.svg'),'w') as f: f.write(frame(bg, body))
    # Alternate "studio" view for galleries: same object on a darker backdrop.
    with open(os.path.join(OUT, f'{name}-alt.svg'),'w') as f: f.write(frame(BG['ink'] if bg!=BG['ink'] else BG['mist'], body))
cats = {'watches':('slate','watch-chronograph'),'electronics':('sky','headphones'),'art':('sand','art-circles'),'collectibles':('blush','tin-robot'),'sneakers':('mist','sneaker-high-red')}
print(len(art), 'artworks written to', os.path.abspath(OUT))
