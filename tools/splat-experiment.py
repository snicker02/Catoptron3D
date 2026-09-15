# EXPERIMENT, not part of the app.
#
# Renders a flame the way a FLAME RENDERER does: run the chaos game forward and accumulate where
# the points land, with a log-density tone map. Nothing here asks "which transform did this point
# come from", so the ambiguity that limits the distance estimator does not exist — there is no
# selection rule, no container and no hull.
#
# Measured on the 21%-ambiguous flame: 4.0 s for 6 million points on the CPU, peak density 460,
# 28% of pixels touched. That is far too few — real flame renderers use 1e8 to 1e9 — which is why
# the output below is grainy. On the GPU with transform feedback the same count takes milliseconds
# and can accumulate progressively across frames.
#
# Run: python3 tools/splat-experiment.py
import numpy as np, math, json, subprocess, time
from PIL import Image
# The chaos game IS the attractor's definition. No estimator, no container, no selection rule,
# no ambiguity — the three sources of every artifact in this project simply do not exist here.
J=json.loads(subprocess.check_output(['node','-e','''
Promise.all([import("/home/claude/catoptron3d/engine/flame.js")]).then(([F])=>{
 const X=o=>({M:[1,0,0,0,1,0,0,0,1],T:[0,0,0],scale:1,rot:[0,0,0],tr:[0,0,0],
   vari:0,vamt:1,vp:F.defaultVP(),chaos:null,on:true,weight:0.5,...o});
 const maps=[X({T:[1,-1,0],rot:[0,-106.5,0],vamt:0.5}),X({T:[1,1,0],vamt:0.5}),
   X({T:[-1,1,0],vamt:0.5}),X({T:[-1,-1,0],vamt:0.5}),
   X({M:[0.5,0,0,0,0.5,0,0,0,0.5],rot:[70.5,-1,0],tr:[0.015,-0.67,0.64],vari:1,vamt:1.565,weight:1})];
 const r=F.resolveFlame({name:"x",select:2,maps});
 console.log(JSON.stringify({maps:r.map(m=>({Aff:m.Aff,Taf:m.Taf,vari:m.vari,vamt:m.vamt,w:(m.weight===undefined?1:m.weight)})),hull:r.hull}));
});''']).decode())
M=J['maps']
Aff=np.array([m['Aff'] for m in M]).reshape(-1,3,3)
Taf=np.array([m['Taf'] for m in M])
VARI=[m['vari'] for m in M]; VAMT=np.array([m['vamt'] for m in M])
W=np.array([m['w'] for m in M],dtype=float); W/=W.sum()
n=len(M)
def variation(vi,q,a):
    if vi==1:                                   # spherical3D
        r2=np.maximum((q*q).sum(1,keepdims=True),1e-9); return a*q/r2
    return a*q                                  # linear3D
t0=time.time()
N=6_000_000; B=500_000
rng=np.random.default_rng(7)
P=np.zeros((B,3)); col=np.zeros(B)
pts=[]; cols=[]
for it in range(N//B+8):
    k=rng.choice(n,size=B,p=W)
    q=np.einsum('nij,nj->ni',Aff[k],P)+Taf[k]
    out=np.empty_like(q)
    for i in range(n):
        m=k==i
        if m.any(): out[m]=variation(VARI[i],q[m],VAMT[i])
    P=out
    col=0.72*col+0.28*(k/(n-1.0))               # colour by which transform, as flames do
    if it>=8: pts.append(P.copy()); cols.append(col.copy())
A=np.concatenate(pts); C=np.concatenate(cols)
print("chaos game: %.1f s for %.1f million points" % (time.time()-t0, len(A)/1e6))
# project with his camera
az,el,d=3.19174,0.882782,1.813178; tgt=np.array([0.,0.,0.])
cp=tgt+np.array([math.cos(az)*math.cos(el)*d, math.sin(el)*d, math.sin(az)*math.cos(el)*d])
fwd=tgt-cp; fwd/=np.linalg.norm(fwd)
up=np.array([0,1,0.]); rgt=np.cross(fwd,up); rgt/=np.linalg.norm(rgt); upv=np.cross(rgt,fwd)
Wp,Hp=760,560; fov=1.86
rel=A-cp
z=rel@fwd
ok=z>1e-4
rel=rel[ok]; z=z[ok]; Cc=C[ok]
u=(rel@rgt)/z*fov; v=(rel@upv)/z*fov
px=(u*Hp/2+Wp/2).astype(np.int32); py=(v*Hp/2+Hp/2).astype(np.int32)
inb=(px>=0)&(px<Wp)&(py>=0)&(py<Hp)
px,py,Cc,z=px[inb],py[inb],Cc[inb],z[inb]
idx=py*Wp+px
dens=np.bincount(idx,minlength=Wp*Hp).astype(np.float64)
csum=np.bincount(idx,weights=Cc,minlength=Wp*Hp)
zsum=np.bincount(idx,weights=1.0/np.maximum(z,1e-6),minlength=Wp*Hp)
nz=dens>0
hue=np.zeros_like(dens); hue[nz]=csum[nz]/dens[nz]
depth=np.zeros_like(dens); depth[nz]=zsum[nz]/dens[nz]
# log-density tone map, as every flame renderer does
a=np.zeros_like(dens); a[nz]=np.log1p(dens[nz])/np.log1p(dens.max())
a=a**0.62
pal=np.array([[0.09,0.12,0.26],[0.20,0.42,0.78],[0.75,0.82,0.95],[0.98,0.80,0.45]])
t=np.clip(hue,0,1)*3
i0=np.clip(t.astype(int),0,2); f=(t-i0)[:,None]
rgbv=pal[i0]*(1-f)+pal[i0+1]*f
sh=0.55+0.45*np.clip(depth/max(depth.max(),1e-9),0,1)[:,None]
img=(np.clip(rgbv*sh*a[:,None],0,1)**(1/2.2)*255).astype(np.uint8).reshape(Hp,Wp,3)
Image.fromarray(np.flipud(img)).save('/mnt/user-data/outputs/splat_proto.png')
print("non-empty pixels: %.1f%%   peak density: %d" % (100*nz.mean(), dens.max()))
print("saved")
