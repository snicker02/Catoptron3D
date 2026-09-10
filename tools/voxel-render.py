import numpy as np, moderngl, math, sys
from PIL import Image
occ=np.load('/tmp/occ.npy'); bnd=np.load('/tmp/bounds.npy'); lo,hi=bnd[0],bnd[1]
G=occ.shape[0]
ctx=moderngl.create_context(standalone=True,backend='egl',require=330)
tex=ctx.texture3d((G,G,G),1,occ.tobytes())
tex.filter=(moderngl.LINEAR,moderngl.LINEAR); tex.repeat_x=tex.repeat_y=tex.repeat_z=False
tex.use(0)
VS="#version 330\nin vec2 aPos;\nvoid main(){gl_Position=vec4(aPos,0.,1.);}"
FS="""#version 330
uniform vec2 uRes; uniform vec3 uCamPos, uCamTgt, uLo, uHi, uLight;
uniform float uFov, uG, uExposure;
uniform sampler3D uOcc;
out vec4 fragColor;
float dens(vec3 p){
  vec3 t=(p-uLo)/(uHi-uLo);
  if(any(lessThan(t,vec3(0.0)))||any(greaterThan(t,vec3(1.0)))) return 0.0;
  return texture(uOcc,t).r;
}
// gradient of the sampled density is the surface normal, and it is smooth because the texture is
// trilinearly interpolated -- no estimator, so nothing to be piecewise about
vec3 grad(vec3 p, float h){
  return normalize(vec3(dens(p+vec3(h,0,0))-dens(p-vec3(h,0,0)),
                        dens(p+vec3(0,h,0))-dens(p-vec3(0,h,0)),
                        dens(p+vec3(0,0,h))-dens(p-vec3(0,0,h)))+vec3(1e-9));
}
bool slab(vec3 ro, vec3 rd, out float t0, out float t1){
  vec3 i0=(uLo-ro)/rd, i1=(uHi-ro)/rd;
  vec3 a=min(i0,i1), b=max(i0,i1);
  t0=max(max(a.x,a.y),a.z); t1=min(min(b.x,b.y),b.z);
  return t1>max(t0,0.0);
}
void main(){
  vec2 uv=(gl_FragCoord.xy-uRes*0.5)/uRes.y;
  vec3 ro=uCamPos, fwd=normalize(uCamTgt-ro);
  vec3 up=abs(fwd.y)>0.999?vec3(0,0,1):vec3(0,1,0);
  vec3 rgt=normalize(cross(fwd,up)), upv=cross(rgt,fwd);
  vec3 rd=normalize(rgt*uv.x+upv*uv.y+fwd*uFov);
  float t0,t1;
  vec3 bg=mix(vec3(0.014,0.016,0.022),vec3(0.05,0.06,0.08),0.5+0.5*rd.y);
  if(!slab(ro,rd,t0,t1)){ fragColor=vec4(bg,1.0); return; }
  float voxel=max(max(uHi.x-uLo.x,uHi.y-uLo.y),uHi.z-uLo.z)/uG;
  float step=voxel*0.5;
  float t=max(t0,0.0);
  for(int i=0;i<2048;i++){
    if(t>t1) break;
    vec3 p=ro+rd*t;
    if(dens(p)>0.25){
      // binary refine to the crossing: exact to well below a voxel
      float a=t-step, b=t;
      for(int j=0;j<12;j++){ float m=0.5*(a+b); if(dens(ro+rd*m)>0.25) b=m; else a=m; }
      p=ro+rd*b;
      vec3 nn=-grad(p,voxel*0.75);
      float dif=max(dot(nn,normalize(uLight)),0.0);
      vec3 col=(vec3(0.42,0.52,0.68)*(0.28+0.72*dif));
      col+=vec3(1.0)*pow(max(dot(reflect(rd,nn),normalize(uLight)),0.0),24.0)*0.35;
      col*=uExposure;
      fragColor=vec4(pow(clamp(col,0.0,1.0),vec3(1.0/2.2)),1.0); return;
    }
    t+=step;
  }
  fragColor=vec4(bg,1.0);
}"""
prog=ctx.program(vertex_shader=VS,fragment_shader=FS)
vbo=ctx.buffer(np.array([-1,-1,1,-1,-1,1,1,1],dtype='f4').tobytes())
va=ctx.vertex_array(prog,[(vbo,'2f','aPos')])
W,H=760,560
az,el,d=2.895,-0.149,2.773068; tgt=(0.,0.,0.)
cp=(math.cos(az)*math.cos(el)*d, math.sin(el)*d, math.sin(az)*math.cos(el)*d)
for k,v in dict(uRes=(float(W),float(H)),uCamPos=cp,uCamTgt=tgt,uFov=1.86,
                uLo=tuple(lo),uHi=tuple(hi),uG=float(G),uExposure=1.3,
                uLight=(0.45,0.68,0.58)).items():
    if k in prog: prog[k].value=v
if 'uOcc' in prog: prog['uOcc'].value=0
fbo=ctx.simple_framebuffer((W,H)); fbo.use(); fbo.clear(0,0,0,1)
import time; ctx.finish(); t0=time.time()
va.render(moderngl.TRIANGLE_STRIP); ctx.finish()
print("render: %.0f ms at %dx%d" % (1000*(time.time()-t0),W,H))
im=np.flipud(np.frombuffer(fbo.read(components=3),dtype=np.uint8).reshape(H,W,3))
g=im@[.299,.587,.114]
gy,gx=np.gradient(g)
print("coverage %.1f%%  flat-plane area %.1f%%" % (100*(np.abs(g-g[2,2])>8).mean(),
                                                   100*((np.abs(gx)+np.abs(gy))<2).mean()))
Image.fromarray(im).save('/mnt/user-data/outputs/voxel_proto.png'); print("saved")
