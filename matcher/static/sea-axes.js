// Axis names and measurements are shared by the controls and the worker; changing a view never edits a photo.
const SeaAxes={
  defaults:{x:'colorfulness',y:'brightness',reverseX:false,reverseY:false},
  options:[
    {key:'colorfulness',label:'Colourfulness',low:'muted',high:'colourful',unit:true},
    {key:'brightness',label:'Brightness',low:'dark',high:'bright',unit:true},
    {key:'hue',label:'Hue',low:'0°',high:'360°',unit:true},
    {key:'saturation',label:'Saturation',low:'soft',high:'vivid',unit:true},
    {key:'date',label:'Capture date',low:'oldest',high:'newest'},
    {key:'quality',label:'Machine ranking',low:'lower',high:'higher',group:'Ranking',description:'The original analysis estimate, before it learns from your comparisons.'},
    {key:'ranking',label:'Your ranking',low:'lower',high:'higher'},
    {key:'sharpness',label:'Sharpness',low:'soft',high:'sharp'},
    {key:'aspect',label:'Aspect ratio',low:'portrait',high:'landscape'},
    {key:'faces',label:'Faces',low:'fewer',high:'more'},
    {key:'aesthetic',label:'Aesthetic score',low:'lower',high:'higher',group:'Ranking',description:'The scene model’s composition and visual appeal estimate.'},
    {key:'technical',label:'Focus & exposure',low:'weaker',high:'stronger',group:'Ranking',description:'Saved sharpness and tonal range, without aesthetic or personal-preference scores.'},
    {key:'shortlist',label:'Shortlist chance',low:'less likely',high:'more likely',group:'Ranking',description:'The current probability of reaching your shortlist.'},
    {key:'uncertainty',label:'Ranking uncertainty',low:'settled',high:'uncertain',group:'Ranking',description:'Where more comparisons could still change the learned ranking.'},
    {key:'comparisons',label:'Comparisons',low:'fewer',high:'more',group:'Ranking',description:'How much direct preference evidence a shot has received.'},
    {key:'contrast',label:'Tonal range',low:'gentle',high:'contrasty',group:'Colour & light',description:'The distance between the measured dark and light tones.'},
    {key:'dark_tones',label:'Shadow brightness',low:'deep',high:'lifted',group:'Colour & light'},
    {key:'light_tones',label:'Highlight brightness',low:'muted',high:'bright',group:'Colour & light'},
    {key:'warmth',label:'Warm / cool palette',low:'cool',high:'warm',group:'Colour & light',description:'The dominant colour’s warm or cool character. Neutral photos have no colour temperature estimate.'},
    {key:'time',label:'Time of day',low:'midnight',high:'late night',group:'Time',description:'The photo’s recorded local capture time; unknown dates stay unknown.'},
    {key:'weekday',label:'Day of week',low:'Monday',high:'Sunday',group:'Time'},
    {key:'month',label:'Month of year',low:'January',high:'December',group:'Time'},
    {key:'year',label:'Year',low:'earlier',high:'later',group:'Time'},
    {key:'megapixels',label:'Resolution',low:'smaller',high:'larger',group:'File & camera'},
    {key:'width',label:'Image width',low:'narrower',high:'wider',group:'File & camera'},
    {key:'height',label:'Image height',low:'shorter',high:'taller',group:'File & camera'},
    {key:'file_size',label:'File size',low:'smaller',high:'larger',group:'File & camera'},
    {key:'filename',label:'Filename',low:'A',high:'Z',group:'File & camera',category:true},
    {key:'folder',label:'Folder',low:'A',high:'Z',group:'File & camera',category:true},
    {key:'camera',label:'Camera',low:'A',high:'Z',group:'File & camera',category:true},
    {key:'format',label:'File format',low:'A',high:'Z',group:'File & camera',category:true},
    {key:'face_size',label:'Face prominence',low:'distant',high:'close',group:'People & subjects',description:'The largest face’s share of the image.'},
    {key:'smile',label:'Smile',low:'subtle',high:'broad',group:'People & subjects'},
    {key:'eyes_open',label:'Eyes open',low:'closed',high:'open',group:'People & subjects'},
    {key:'face_angle',label:'Face direction',low:'front',high:'profile',group:'People & subjects'},
    {key:'head_tilt',label:'Head tilt',low:'level',high:'tilted',group:'People & subjects'},
    {key:'subject_size',label:'Subject size',low:'distant',high:'close',group:'People & subjects'},
    {key:'subject_x',label:'Subject position across',low:'left',high:'right',group:'People & subjects'},
    {key:'subject_y',label:'Subject position down',low:'top',high:'bottom',group:'People & subjects'},
    {key:'category',label:'Main subject',low:'A',high:'Z',group:'People & subjects',category:true},
    {key:'stack_size',label:'Stack size',low:'loose',high:'many takes',group:'Your collection'},
    {key:'tag_count',label:'Number of tags',low:'fewer',high:'more',group:'Your collection'},
    {key:'group',label:'Group',low:'A',high:'Z',group:'Your collection',category:true},
    {key:'decision',label:'Keep / set aside',low:'set aside',high:'kept',group:'Your collection',description:'Set-aside photos, then undecided photos, then explicit keeps.'},
    {key:'edited',label:'Finishing progress',low:'untouched',high:'adjusted',group:'Your collection',description:'How many finishing choices you have made for this photo.'}
  ],
  normalize(value){
    const keys=this.options.map(o=>o.key),v=value||{};
    return {x:keys.includes(v.x)?v.x:this.defaults.x,y:keys.includes(v.y)?v.y:this.defaults.y,reverseX:v.reverseX===true,reverseY:v.reverseY===true};
  },
  value(it,key){
    const value=key==='colorfulness'?(it.visual?.colorfulness??it.visual?.saturation):['brightness','hue','saturation'].includes(key)?it.visual?.[key]:it.measurements?.[key];
    if(this.option(key)?.category)return typeof value==='string'&&value.trim()?value.toLocaleLowerCase():null;
    return Number.isFinite(value)?value:null;
  },
  group(option){return option.group||(['colorfulness','brightness','hue','saturation'].includes(option.key)?'Colour & light':['quality','ranking'].includes(option.key)?'Ranking':option.key==='date'?'Time':['sharpness','aspect'].includes(option.key)?'File & camera':'People & subjects');},
  option(key){this.lookup||=new Map(this.options.map(o=>[o.key,o]));return this.lookup.get(key);},
  label(key){return this.option(key)?.label||'';},
  equal(a,b){return JSON.stringify(this.normalize(a))===JSON.stringify(this.normalize(b));}
};
if(typeof module!=="undefined")module.exports=SeaAxes;
