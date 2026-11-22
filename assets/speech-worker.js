// Browser-only local synthesis. Keep ONNX inference off the UI thread.
import {TextToSpeech} from './moonshine/index.js';
let tts,voice;
self.onmessage=async({data})=>{
  const {id,text,voice:requested}=data;
  try{
    if(!tts||voice!==requested){
      self.postMessage({id,type:'loading'});
      tts?.close();tts=new TextToSpeech().voice(requested).language('en');voice=requested;
      tts.onProgress((fraction,file)=>self.postMessage({id,type:'progress',fraction,file}));
      await tts.load();
    }
    // synthesize() is the raw single-utterance API. Use the SDK's sentence
    // splitter, as its higher-level say() does, instead of feeding whole pages.
    self.postMessage({id,type:'synthesizing'});
    const sentences=tts.splitUtterances(text),chunks=[];
    for(const sentence of sentences){
      let part='';
      for(const word of sentence.split(/\s+/)){
        if(part.length+word.length>240&&part){chunks.push(tts.synthesize(part));part='';}
        part+=(part?' ':'')+word;
      }
      if(part)chunks.push(tts.synthesize(part));
    }
    if(!chunks.length)throw Error('No spoken text');
    const sampleRate=chunks[0].sampleRate,gap=Math.round(sampleRate*.12);
    const audio=new Float32Array(chunks.reduce((n,c)=>n+c.audio.length,0)+gap*(chunks.length-1));
    let offset=0;for(const chunk of chunks){audio.set(chunk.audio,offset);offset+=chunk.audio.length+gap;}
    const result={audio,sampleRate};
    self.postMessage({id,type:'audio',audio:result.audio,sampleRate:result.sampleRate},[result.audio.buffer]);
  }catch(error){self.postMessage({id,type:'error',message:error.message});tts?.close();tts=null;}
};
