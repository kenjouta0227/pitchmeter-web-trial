// Minimal x265 (alpha) wrapper for WebAssembly: YUVA420 in -> Annex-B HEVC NALs out.
#include <x265.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <emscripten.h>
static x265_param* P; static x265_encoder* E; static x265_picture* PIC;
static uint8_t* OUT; static int OUTN, OUTCAP; static int W,H;
static void put(x265_nal* n, uint32_t c){ for(uint32_t i=0;i<c;i++){ int need=OUTN+(int)n[i].sizeBytes; if(need>OUTCAP){OUTCAP=need*2;OUT=realloc(OUT,OUTCAP);} memcpy(OUT+OUTN,n[i].payload,n[i].sizeBytes); OUTN+=n[i].sizeBytes; } }
EMSCRIPTEN_KEEPALIVE int hv_open(int w,int h,int fps,float crf,const char* preset){
  W=w;H=h; P=x265_param_alloc(); if(x265_param_default_preset(P,preset,NULL)<0) return -1;
  x265_param_parse(P,"pools","none"); x265_param_parse(P,"frame-threads","1"); x265_param_parse(P,"lookahead-slices","0"); x265_param_parse(P,"wpp","0");
  x265_param_parse(P,"bframes","0"); x265_param_parse(P,"keyint","60"); x265_param_parse(P,"open-gop","0"); x265_param_parse(P,"min-keyint","1");
  x265_param_parse(P,"repeat-headers","0"); x265_param_parse(P,"annexb","1"); x265_param_parse(P,"info","0");
  x265_param_parse(P,"colorprim","bt709"); x265_param_parse(P,"transfer","bt709"); x265_param_parse(P,"colormatrix","bt709"); x265_param_parse(P,"range","limited");
  if(x265_param_parse(P,"alpha","1")) return -2;
  P->sourceWidth=w;P->sourceHeight=h;P->fpsNum=fps;P->fpsDenom=1;P->internalCsp=X265_CSP_I420;P->logLevel=X265_LOG_ERROR;
  P->rc.rateControlMode=X265_RC_CRF;P->rc.rfConstant=crf;
  if(x265_param_apply_profile(P,"main")<0) return -3;
  E=x265_encoder_open(P); if(!E) return -4;
  PIC=x265_picture_alloc(); x265_picture_init(P,PIC); PIC->colorSpace=X265_CSP_I420; PIC->bitDepth=8;
  PIC->stride[0]=w;PIC->stride[1]=w/2;PIC->stride[2]=w/2; PIC->framesize=w*h*5/2;
  x265_nal* n; uint32_t c; OUTN=0; if(x265_encoder_headers(E,&n,&c)<0) return -5; put(n,c); return OUTN;
}
EMSCRIPTEN_KEEPALIVE uint8_t* hv_out(void){return OUT;}
EMSCRIPTEN_KEEPALIVE int hv_outn(void){return OUTN;}
// buf: Y(w*h) U(w*h/4) V(w*h/4) A(w*h). returns bytes produced; *key flag via hv_lastkey
static int LASTKEY, NPIC;
EMSCRIPTEN_KEEPALIVE int hv_lastkey(void){return LASTKEY;}
EMSCRIPTEN_KEEPALIVE int hv_npic(void){return NPIC;}
EMSCRIPTEN_KEEPALIVE int hv_encode(uint8_t* buf,int pts){
  x265_nal* n=0; uint32_t c=0; x265_picture outp[MAX_LAYERS]; x265_picture* po=outp;
  OUTN=0; LASTKEY=0; NPIC=0; int r;
  if(buf){ PIC->planes[0]=buf;PIC->planes[1]=buf+W*H;PIC->planes[2]=buf+W*H+W*H/4;PIC->planes[3]=buf+W*H*3/2;PIC->pts=pts; r=x265_encoder_encode(E,&n,&c,PIC,po); }
  else r=x265_encoder_encode(E,&n,&c,NULL,po);
  if(r<0) return -1; if(r>0){ put(n,c); NPIC=r; LASTKEY=IS_X265_TYPE_I(outp[0].sliceType); }
  return OUTN;
}
EMSCRIPTEN_KEEPALIVE uint8_t* hv_malloc(int n){return malloc(n);}
EMSCRIPTEN_KEEPALIVE void hv_close(void){ if(E)x265_encoder_close(E); E=0; if(PIC)x265_picture_free(PIC); PIC=0; if(P)x265_param_free(P); P=0; }
#include <semaphore.h>
int sem_close(sem_t* s){(void)s;return 0;} int sem_unlink(const char* n){(void)n;return 0;}
