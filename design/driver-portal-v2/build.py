from pathlib import Path
from html import escape
import json, math
OUT=Path(__file__).parent
INK='#172A25'; MUT='#65766E'; GREEN='#207C62'; AMBER='#B8791C'; RED='#B54C39'; LINE='#E7ECE7'
def text(x,y,s,size=14,c=INK,w=400): return f'<text x="{x}" y="{y}" font-family="Inter, Arial, sans-serif" font-size="{size}" font-weight="{w}" fill="{c}">{escape(s)}</text>'
def rect(x,y,w,h,c='#FFFFFF',r=0,stroke='none'): return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{c}" stroke="{stroke}"/>'
def path(d,c=INK,w=2): return f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>'
def circ(x,y,r,c): return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c}"/>'
def line(y,x=36,w=330): return path(f'M{x} {y}h{w}',LINE,1)
def card(y,h,x=16,w=370): return rect(x,y+5,w,h,'#B9C8BA',24)+rect(x,y,w,h,'white',24)
def button(y,s,x=36,w=330,c=GREEN,fg='white'): return rect(x,y,w,48,c,13)+text(x+w/2-len(s)*3.9,y+30,s,15,fg,600)
def smallpill(x,y,s,c=GREEN,bg='#EAF4ED',w=None):
 w=w or len(s)*6.6+22
 return rect(x,y,w,25,bg,13)+text(x+11,y+17,s,11,c,600)
def chevron(x,y): return path(f'M{x} {y-4}l4 4-4 4',MUT,1.8)
def mapview(city='CAMBRIDGE',mode='road'):
 s=rect(0,0,402,874,'#E6ECE2')
 s+='<path d="M0 118L80 98L112 178L42 218L0 198ZM257 134L402 106V237L310 258ZM0 345L80 318L126 449L0 475ZM266 360L402 316V497L319 520ZM0 690L138 663L201 787L0 811Z" fill="#D0DEC8"/>'
 s+=path('M270 0Q230 100 273 182T243 313T280 489T243 706T280 900','#BDD9D4',14)
 for d in ['M-20 204L422 70','M-20 290L422 155','M-20 379L422 240','M-20 466L422 325','M-20 558L422 415','M-20 650L422 509','M-20 746L422 604','M-20 842L422 702','M55 80L325 900','M155 30L402 782','M-45 135L202 900','M340 20L402 221']:
  s+=path(d,'#F9FBF7',6)
 s+=path('M-20 400C83 396 132 285 226 279S336 258 428 207','#B8C8B7',21)+path('M-20 400C83 396 132 285 226 279S336 258 428 207','#FFFFFF',16)
 s+=text(35,254,city,14,'#82907E',600)+text(269,350,'PUSLINCH',11,'#82907E',500)+rect(219,298,34,21,'white',5)+text(225,313,'401',11,MUT,600)+text(40,435,'Hespeler Rd',11,'#82907E')
 if mode=='dock':
  s+=rect(202,205,107,64,'#C0CEC0',7,'#A6B8A6')+rect(211,214,35,45,'#A6B8A6',2)+rect(253,214,45,45,'#A6B8A6',2)+circ(257,247,19,'white')+circ(257,247,14,GREEN)+text(251,252,'P',13,'white',700)
 else:
  s+=path('M103 334C148 288 175 279 226 279S330 261 359 245',GREEN,6)+circ(132,312,24,'white')+circ(132,312,19,GREEN)+'<path d="M132 299L142 320L132 316L122 320Z" fill="white"/>'
  s+=circ(322,260,13,INK)+text(317,265,'P',13,'white',700)
 return s

def status(time='13:05'):
 return text(24,31,time,14,INK,600)+rect(143,11,116,28,INK,16)+path('M339 26v-4m5 4v-7m5 7V16',INK,2.5)+rect(364,19,20,10,'none',3,INK)+rect(367,22,13,4,INK,1)
def icon(kind,x,y,c=MUT):
 if kind=='Today':return path(f'M{x-8} {y}l8-7 8 7v10h-6v-6h-4v6h-6Z',c,1.7)
 if kind=='Log':return path(f'M{x-8} {y-5}h16m-16 6h16m-16 6h11',c,1.7)
 if kind=='Parking':return rect(x-8,y-7,16,18,'none',4,c)+text(x-4,y+7,'P',13,c,600)
 return circ(x,y-3,4,'none')+f'<circle cx="{x}" cy="{y-3}" r="4" fill="none" stroke="{c}" stroke-width="1.7"/>'+path(f'M{x-8} {y+10}q0-7 8-7t8 7',c,1.7)
def nav(active='Today'):
 s=rect(0,793,402,81,'#FFFFFF')+line(793,0,402)
 for i,k in enumerate(['Today','Log','Parking','Me']):
  x=51+i*100; c=GREEN if k==active else '#85918B'
  if k==active:s+=rect(x-22,801,44,29,'#E9F3EB',14)
  s+=icon(k,x,813,c)+text(x-len(k)*3.1,847,k,12,c,600 if k==active else 400)
 return s+rect(133,861,136,5,INK,3)
def top(title,sub=None):
 s=card(63,76 if sub else 55)+text(37,94,title,17,INK,600)
 if sub:s+=text(37,119,sub,13,MUT)
 return s

def rings(y,critical=False):
 vals=[('Driving','4:20','13:00',4.333/13,GREEN),('On duty','12:15','14:00',12.25/14,AMBER),('Elapsed','12:15','16:00',12.25/16,AMBER),('Cycle 1','48:00','70:00',48/70,GREEN)]
 if critical: vals=[('Driving','11:45','13:00',11.75/13,RED),('On duty','12:30','14:00',12.5/14,AMBER),('Elapsed','12:48','16:00',12.8/16,AMBER),('Cycle 1','51:40','70:00',51.67/70,GREEN)]
 s=''
 for i,(label,used,limit,f,c) in enumerate(vals):
  x=65+i*91
  s+=f'<circle cx="{x}" cy="{y}" r="30" fill="none" stroke="#E9EEEA" stroke-width="4"/><circle cx="{x}" cy="{y}" r="30" fill="none" stroke="{c}" stroke-width="4" stroke-dasharray="{188.5*f} 188.5" stroke-linecap="round" transform="rotate(-90 {x} {y})"/>'
  s+=text(x-18,y+1,used,14,c,650)+text(x-16,y+15,'/'+limit,9,MUT)+text(x-len(label)*3,y+51,label,11,MUT,500)
 return s

def identity(y,state='Driving'):
 return circ(52,y,19,'#EAF0E9')+text(42,y+4,'PR',11,GREEN,650)+text(81,y-3,'Priya Raman',16,INK,600)+text(81,y+17,'GLD-118 · ON BJ 4821',11,MUT)+smallpill(293,y-12,state,w=72)
def handle(y):return rect(176,y+10,50,4,'#D9E1D9',3)
def base(city='CAMBRIDGE',mode='road',time='13:05'):return mapview(city,mode)+status(time)
S=[]
def add(name,body,note):S.append((name,body,note))
# 01, floating Today
s=base()+top('Continue on Highway 401','Cambridge DC · 32 min · 28 km')
s+=circ(359,413,23,'white')+path('M350 413h18m-9-9v18',INK,1.7)
s+=card(452,307)+handle(452)+identity(494)+line(535)+text(36,560,'Hours of service',14,INK,600)+text(295,560,'Used / limit',11,MUT)+rings(607)
s+=line(670)+text(36,696,'CURRENT LOAD · MG-4482',10,MUT,600)+text(36,722,'Cambridge DC',18,INK,600)+text(36,743,'Due 15:30 · Stop 2 of 3',12,MUT)+chevron(360,724)+nav()
add('01 · Today / driving',s,'Floating card · HOS status rings · 34 px map gap above navigation')
# 02 Offer
s=base()+top('New load available','You’re parked · Review your next trip')+card(388,371)+handle(388)+smallpill(36,414,'NEW OFFER · FTL')+text(36,469,'London → Cambridge',23,INK,650)+text(36,497,'MG-4482 · Pickup at London DC',13,MUT)
s+=line(518)+text(36,547,'110 km',21,INK,600)+text(158,547,'15:30',21,INK,600)+text(285,547,'18.4 t',21,INK,600)+text(36,568,'Trip distance',11,MUT)+text(158,568,'Delivery due',11,MUT)+text(285,568,'Load weight',11,MUT)
s+=smallpill(36,590,'✓ HOS and weight checks passed',GREEN,w=273)+text(36,639,'Offer expires at 13:09',12,MUT)+button(665,'Accept load',w=212)+button(665,'Reject',x=260,w=106,c='#EFF3ED',fg=INK)+text(123,740,'View load details  →',12,GREEN,600)+nav()
add('02 · New load offer',s,'Real accept / reject choice · Compliance result before acceptance')
# 03 Load detail
s=base()+top('‹  Load details','MG-4482 · Full truckload')+card(306,453)+smallpill(36,329,'ACCEPTED')+text(36,383,'London → Cambridge',23,INK,650)
s+=circ(45,422,5,GREEN)+path('M45 434v43','#C5D2C8',2)+circ(45,490,5,INK)+text(64,424,'London Distribution Centre',15,INK,600)+text(64,446,'Pickup complete · Departed 12:58',12,MUT)+text(64,492,'Cambridge Distribution Centre',15,INK,600)+text(64,514,'Delivery due 15:30 · Dock 4',12,MUT)+line(540)
s+=text(36,568,'Arrival instructions',13,INK,600)+text(36,594,'Use the east truck entrance.',14,MUT)+text(36,616,'Check in at the gate with load MG-4482.',13,MUT)+line(638)+text(36,664,'18,400 kg · Trailer TR-204',13,MUT)+button(687,'Navigate to delivery',w=244)+button(687,'Call',x=290,w=76,c='#EFF3ED',fg=INK)+nav()
add('03 · Active load details',s,'Stops, dock instructions and trip actions without leaving map context')
# 04 dock
s=base('LONDON','dock','08:28')+top('Arrived at London DC','Geofence recorded your arrival at 08:20')+card(410,349)+identity(454,'Docked')+line(493)+text(36,520,'FREE DOCK TIME',11,AMBER,650)+text(36,573,'1:52',44,INK,650)+text(164,550,'remaining',14,MUT)+text(164,574,'Ends at 10:20',14,MUT)
s+=rect(36,592,330,5,'#EBEEE6',3)+rect(36,592,22,5,AMBER,3)+text(36,625,'Detention begins after the free window.',13,MUT)+text(36,648,'Your arrival record is saved automatically.',12,MUT)+button(682,'Report delay',w=218)+button(682,'Dispatch',x=264,w=102,c='#EFF3ED',fg=INK)+nav()
add('04 · At the dock',s,'Arrival evidence and free-time countdown · Contextual escalation')
# 05 delay
s=base('LONDON','dock','09:38')+top('‹  Report a delay','London Distribution Centre')+card(293,466)+text(36,334,'What’s holding you up?',23,INK,650)+text(36,359,'Dispatch will receive your dock record.',13,MUT)
for j,(label,selected) in enumerate([('Waiting for a dock',True),('Loading / unloading',False),('Paperwork',False)]):
 y=381+j*53
 s+=rect(36,y,330,43,'#EAF4ED' if selected else '#F4F6F2',10)+f'<circle cx="55" cy="{y+21}" r="7" fill="white" stroke="{GREEN if selected else "#ADBAB0"}" stroke-width="1.5"/>'+(circ(55,y+21,3.5,GREEN) if selected else '')+text(74,y+26,label,14,INK,500)
s+=text(36,568,'Add a note (optional)',12,MUT)+rect(36,581,330,66,'#F4F6F2',10)+text(49,606,'Gate queue has not moved.',13,INK)+text(36,675,'Includes arrival time and current HOS.',12,MUT)+button(693,'Send to dispatch')+nav()
add('05 · Report delay',s,'A focused action state with a reason, optional note and explicit send')
# 06 parking critical
s=base(time='19:12')+top('Rest stop ahead · 18 km','ONroute Trafalgar · About 14 min away')+smallpill(231,225,'1 projected space',GREEN,w=152)+card(402,357)+handle(402)+rect(36,429,330,47,'#FBEDE7',12)+text(50,459,'1:15 driving left',20,RED,650)+text(36,507,'RECOMMENDED STOP',11,MUT,600)+text(36,540,'ONroute Trafalgar',25,INK,650)+text(36,566,'18 km ahead · Only reachable stop ahead',12,MUT)
s+=smallpill(36,584,'94% full · 1 projected space',AMBER,'#FAF1DF',w=252)+text(36,634,'Estimate only. A claim does not reserve a bay.',12,MUT)+button(660,'View stop & claim')+text(82,740,'Behind you: Cambridge North  →',12,GREEN,600)+nav('Parking')
add('06 · Parking / HOS low',s,'Actionable rest recommendation · Estimates and constraints stay visible')
# 07 parking detail
s=base(time='19:12')+top('‹  Parking details','ONroute Trafalgar · Eastbound')+card(354,405)+text(36,397,'ONroute Trafalgar',24,INK,650)+text(36,424,'18 km · 14 min · Highway 401 eastbound',12,MUT)+line(447)+text(36,481,'1',32,AMBER,600)+text(94,476,'projected space',15,INK,600)+text(94,498,'18 total · Updated just now',12,MUT)+line(519)
s+=text(36,549,'Truck parking · Washrooms · Food',13,INK,500)+text(36,577,'Enter from the eastbound service road.',12,MUT)+rect(36,598,330,57,'#FAF1DF',12)+text(49,621,'A claim shares your plan with the fleet.',12,INK)+text(49,641,'Availability is checked again on arrival.',12,MUT)+button(674,'Claim this stop')+text(145,744,'Call dispatch',12,GREEN,600)+nav('Parking')
add('07 · Parking details',s,'Explain a claim before committing · Facilities and access directions')
# 08 claimed
s=base(time='19:13')+top('Continue to Trafalgar','Claim shared · Arrive in about 14 min')+card(464,295)+circ(58,505,20,'#EAF4ED')+path('M49 505l6 6 12-13',GREEN,2.5)+text(91,501,'Your stop is planned',21,INK,600)+text(91,524,'ONroute Trafalgar',13,MUT)+line(547)+text(36,578,'Dispatch can see where you’re heading.',13,MUT)+text(36,601,'This is not a guaranteed parking reservation.',12,MUT)+button(627,'Continue navigation')+text(117,710,'Change or release claim',13,GREEN,600)+text(109,738,'1:14 driving time remaining',12,MUT)+nav('Parking')
add('08 · Parking claim shared',s,'Clear confirmation · Navigation next · Change or release remains available')
# 09 Log
s=base()+top('Duty log','Monday, September 7 · Cycle 1')+card(193,566)+text(36,229,'Hours of service',17,INK,600)+text(293,229,'Used / limit',11,MUT)+rings(277)+line(347)+text(36,376,'Today’s timeline',16,INK,600)
for j,k in enumerate(['Off','Sleeper','Driving','On duty']):
 y=404+j*28;s+=text(36,y+4,k,10,MUT)+path(f'M88 {y}H363',LINE,1)
# A simplified elapsed day strip, explicit day range and statuses
s+=path('M89 404H98.51V488H134.67V460H184.14V488H238.37V460',GREEN,2.5)
for x,label in [(89,'00'),(158,'06'),(227,'12'),(296,'18'),(361,'24')]:s+=text(x-5,518,label,10,MUT)
s+=line(539)+text(36,568,'Current status',12,MUT)+smallpill(278,550,'Driving',GREEN,w=88)+text(36,596,'Automatic while the truck is moving.',12,MUT)+button(620,'View duty events',c='#EFF3ED',fg=INK)+text(36,697,'Logs sync from your ELD.',13,INK,500)+text(36,721,'Review duty changes when safely parked.',12,MUT)+nav('Log')
add('09 · Log / HOS status',s,'Status rings, a readable duty timeline and ELD-backed events')
# 10 duty events
s=base(mode='dock')+top('‹  Duty events','Monday, September 7')+card(239,520)+text(36,280,'Today’s activity',22,INK,600)
for j,(time,label,sub,c) in enumerate([('13:05','Driving','Automatic · Truck moving',GREEN),('12:58','On duty','Departure inspection',AMBER),('12:20','On duty','At London Distribution Centre',AMBER),('08:20','On duty','Arrival recorded by geofence',AMBER),('00:50','On duty','Shift started after rest',AMBER)]):
 y=319+j*69;s+=circ(44,y,4,c)+text(60,y+4,time,12,MUT)+text(119,y+4,label,14,INK,600)+text(119,y+25,sub,11,MUT)
s+=button(684,'Request a log correction',c='#EFF3ED',fg=INK)+nav('Log')
add('10 · Duty event history',s,'An auditable sequence · Correction request instead of silently rewriting logs')
# 11 Me
s=base(mode='dock')+top('Driver profile','Your account and vehicle')+card(235,524)+circ(201,290,31,'#EAF4ED')+text(186,297,'PR',18,GREEN,600)+text(131,347,'Priya Raman',23,INK,600)+text(114,372,'Corridor Transport · Driver',13,MUT)+line(395)
for j,(title,sub) in enumerate([('My truck','GLD-118 · ON BJ 4821'),('Documents','Licence, vehicle and carrier documents'),('Notifications','Load offers, HOS and parking'),('Help & dispatch','Contact your dispatcher')]):
 y=426+j*66;s+=text(36,y,title,15,INK,600)+text(36,y+22,sub,12,MUT)+chevron(357,y+7)
s+=text(163,736,'Sign out',14,GREEN,600)+nav('Me')
add('11 · Me / profile',s,'Vehicle, documents, notifications and human support')
# 12 signed out
s=mapview()+status('08:00')+text(32,103,'CORRIDOR',22,INK,700)+text(32,133,'Your shift, in one place.',15,MUT)+card(330,429)+text(36,376,'Ready for the road?',27,INK,650)+text(36,405,'Sign in to your assigned truck.',14,MUT)+text(36,450,'Driver ID',12,MUT)+rect(36,465,330,51,'#F2F5EF',12)+text(51,497,'DR-118',16,INK,500)+text(36,547,'Driver PIN',12,MUT)+''.join(rect(36+i*85,562,75,54,'#F2F5EF',12)+circ(73+i*85,589,4,INK) for i in range(4))+button(644,'Start my shift')+text(104,725,'Need access? Contact dispatch',12,GREEN,600)+rect(133,854,136,5,INK,3)
add('12 · Driver sign-in',s,'Assigned-truck entry point · The same map and floating-card language')
# SVGs import as editable Figma vectors and text, never raster screenshots.
def wrap(body,w=402,h=874):return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{body}</svg>'
for i,(name,body,note) in enumerate(S):
 clipped=f'<defs><clipPath id="screen{i}">{rect(0,0,402,874,"white",28)}</clipPath></defs><g clip-path="url(#screen{i})">{body}</g>'
 (OUT/f'{i+1:02d}.svg').write_text(wrap(clipped))
w=1884;h=3140
b=rect(0,0,w,h,'#F5F6F2')+text(42,49,'CORRIDOR / DRIVER PORTAL',12,GREEN,700)+text(42,94,'A clearer view of the whole shift.',36,INK,650)+text(42,125,'Floating cards. HOS status rings. One consistent journey from sign-in to the next safe stop.',16,MUT)
for i,(name,body,note) in enumerate(S):
 x=42+(i%4)*462;y=195+(i//4)*962
 b+=text(x,y-22,name,14,INK,600)+f'<defs><clipPath id="screen{i}">{rect(0,0,402,874,"white",28)}</clipPath></defs><g id="screen-{i+1}" transform="translate({x} {y})" clip-path="url(#screen{i})">{body}</g>'
 # short caption uses two lines for readability
 words=note.split(); rows=[''];
 for word in words:
  if len(rows[-1])+len(word)>57:rows.append(word)
  else:rows[-1]+=(' ' if rows[-1] else '')+word
 for k,row in enumerate(rows):b+=text(x,y+898+k*17,row,11,MUT)
b+=text(42,3111,'DESIGN CONCEPT · Illustrative maps and sample records · Interactions shown as separate states · HOS rings show used / limit',12,MUT)
board=wrap(b,w,h);(OUT/'driver-portal-v2.svg').write_text(board)
# Preview exposes a normal copy action to transfer this exact design into Figma.
html='''<!doctype html><html><head><meta charset="utf-8"><title>Driver portal — Floating cards v2</title><style>body{margin:0;background:#eef1eb;color:#172a25;font:15px Arial}header{position:sticky;top:0;display:flex;gap:16px;align-items:center;padding:18px 28px;background:white;border-bottom:1px solid #ddd;z-index:2}h1{font-size:18px;margin:0;margin-right:auto}button{background:#207c62;border:0;color:white;border-radius:8px;padding:12px 18px;cursor:pointer}#status{min-width:120px;font-size:13px}main{padding:30px;display:grid;grid-template-columns:repeat(4,minmax(220px,1fr));gap:32px}article img{width:100%;border-radius:24px;box-shadow:0 5px 20px #172a2512}article h2{font-size:15px}article p{line-height:1.5;color:#65766e;font-size:13px}article button{margin-bottom:12px;background:#dce9df;color:#172a25}</style></head><body><header><h1>Driver portal · Floating cards v2</h1><span id="status">12 editable screens</span><button id="copy">Copy full board for Figma</button></header><main>'''
for i,(name,body,note) in enumerate(S):html+=f'<article><h2>{escape(name)}</h2><button data-screen="{i+1:02d}.svg">Copy screen</button><img src="{i+1:02d}.svg"><p>{escape(note)}</p></article>'
html+='''</main><script>async function copy(file){const s=await(await fetch(file)).text();await navigator.clipboard.writeText(s);document.querySelector('#status').textContent='Copied — paste in Figma';}document.querySelector('#copy').onclick=()=>copy('driver-portal-v2.svg');document.querySelectorAll('[data-screen]').forEach(b=>b.onclick=()=>copy(b.dataset.screen));</script></body></html>'''
(OUT/'index.html').write_text(html)
print('Generated 12 editable SVG screens, Figma board and local preview.')
