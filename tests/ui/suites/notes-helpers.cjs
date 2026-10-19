// Advanced editing stays behind its named disclosure. Exercise the same control a person opens.
async function adjustment(page,name){
  const section=page.locator(`.photo-note-sheet [data-notes-detail="${name}"]`);
  if(!await section.evaluate(el=>el.open))await section.locator(':scope > summary').click();
}
module.exports={adjustment};
