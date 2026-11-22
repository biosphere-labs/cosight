(function () {
  const home = window.CoSightHome;
  const trigger = $('previousQuestions');
  const dialog = document.createElement('dialog');
  dialog.id = 'questionHistory';
  dialog.setAttribute('aria-labelledby', 'historyHeading');
  dialog.innerHTML = `<div class="history-header"><h2 id="historyHeading">Previous questions</h2>
    <form method="dialog"><button aria-label="Close previous questions">Close</button></form></div>
    <input type="search" aria-label="Search previous questions" placeholder="Search questions" autofocus>
    <p role="status"></p><ul></ul>`;
  document.body.append(dialog);
  const search = dialog.querySelector('input');
  const status = dialog.querySelector('[role=status]');
  const list = dialog.querySelector('ul');
  let project, questions, request = 0;
  const currentProject = () => home.visible() ? home.project() : doc?.project;

  async function get(url) {
    const response = await fetch(url);
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Could not load questions');
    return value;
  }
  function action(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = async () => {
      if (currentProject() !== project) { dialog.close(); return; }
      button.disabled = true;
      try { await onClick(); } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
    return button;
  }
  async function openAnswer(question) {
    const version = request;
    const {tours} = await get('library?project=' + encodeURIComponent(project));
    if (version !== request || currentProject() !== project) return;
    const tour = tours.find(item => item.tourId === question.tourId);
    const ref = question.answer;
    const exists = ref.type === 'aside' ? tour?.asides.some(a => a.id === ref.id) : tour?.stops.some(s => s.n === ref.n);
    if (!exists) throw Error('This saved answer is no longer available. You can still reuse the question.');
    await window.CoSightLibrary.openTour(tour, ref);
    dialog.close();
  }
  async function reuse(question) {
    if (reviewingArchive) {
      if (!await home.openProject(project)) throw Error('Could not open the project to reuse this question.');
      home.show();
    }
    dialog.close();
    const field = $('askin');
    field.value = question.text.replace(/\r\n|[\r\n]/g, ' ');
    field.dispatchEvent(new Event('input', {bubbles: true}));
    field.focus();
  }
  function render() {
    const term = search.value.trim().toLocaleLowerCase();
    const matches = questions.filter(q => q.text.toLocaleLowerCase().includes(term));
    list.replaceChildren();
    status.textContent = matches.length ? '' : questions.length ? 'No matching questions.' : 'No previous questions for this project yet.';
    for (const question of matches) {
      const row = document.createElement('li');
      const text = document.createElement('strong');
      text.textContent = question.text;
      const detail = document.createElement('small');
      const context = question.kind === 'tour' ? 'Project question' : 'Follow-up · Step ' + question.step;
      detail.textContent = [context, question.at && new Date(question.at).toLocaleString(), !question.answer && 'No saved answer'].filter(Boolean).join(' · ');
      const actions = document.createElement('div');
      if (question.answer) actions.append(action('View answer', () => openAnswer(question)));
      actions.append(action('Use question', () => reuse(question)));
      row.append(text, detail, actions);
      list.append(row);
    }
  }
  trigger.onclick = async () => {
    project = currentProject();
    const version = ++request;
    questions = [];
    search.value = '';
    search.disabled = true;
    list.replaceChildren();
    status.textContent = 'Loading previous questions…';
    dialog.showModal();
    try {
      const result = await get('question-history?project=' + encodeURIComponent(project || ''));
      if (version !== request || !dialog.open) return;
      questions = result.questions;
      render();
      search.disabled = false;
      search.focus();
    } catch (error) { if (version === request) status.textContent = error.message; }
  };
  search.oninput = render;
  dialog.onclose = () => { request++; };
  dialog.addEventListener('keydown', event => event.stopPropagation());
  window.addEventListener('cosight:document', () => {
    if (dialog.open && currentProject() !== project) dialog.close();
  });
})();
