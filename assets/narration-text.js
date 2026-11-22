/* Spoken text only. Never rewrite the stored/displayed narration. */
(function(root){
  root.CoSightNarrationText=text=>String(text||'')
    .replace(/`([^`]+)`/g,'$1')
    .replace(/[*#]/g,'')
    .replace(/([a-zA-Z])_([a-zA-Z])/g,'$1 $2')
    .replace(/\b[A-Za-z][A-Za-z0-9]*\b/g,word=>{
      if(!/[A-Z]/.test(word.slice(1)))return word;
      return word.replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2')
        .replace(/([a-z0-9])([A-Z])/g,'$1 $2').split(' ')
        .map(part=>/^[A-Z]{2,}$/.test(part)?part.split('').join(' '):part.toLowerCase()).join(' ');
    });
})(globalThis);
