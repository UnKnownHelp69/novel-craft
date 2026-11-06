/* Characters, locations and races: the lists in the left panel and their inline editors. */
import { $ } from './dom.js';
import { esc, uuid } from './lib/text.js';
import { novel } from './state.js';
import { markDirty } from './dirty.js';
import { updateSceneMeta } from './tree.js';
import { confirmModal, toast } from './dialogs.js';
import { drawGraph, graphOpen, renderLegend } from './graph.js';
import { t } from './i18n/index.js';

/* Labels are i18n keys, translated where they are rendered (the language can change at runtime). */
const subtitleOf = (keys, v) => (keys[v] ? t(keys[v]) : '');
export const ENTITY_DEFS = {
  characters: {
    listEl: '#charList',
    empty: () => ({ id: uuid(), name: '', role: 'main', age: '', appearance: '', personality: '', bio: '', history: '', motivation: '', relationshipNotes: '', notes: '', relationships: [], graphPosition: null, hiddenInGraph: false }),
    subtitle: e => subtitleOf({ main: 'entities.roleMain', supporting: 'entities.roleSupporting', minor: 'entities.roleMinor' }, e.role),
    fields: [
      { key: 'name', label: 'entities.name', type: 'input' },
      { key: 'role', label: 'entities.role', type: 'select', options: [['main', 'entities.roleMain'], ['supporting', 'entities.roleSupporting'], ['minor', 'entities.roleMinor']] },
      { key: 'age', label: 'entities.age', type: 'input' },
      { key: 'appearance', label: 'entities.appearance', type: 'textarea' },
      { key: 'personality', label: 'entities.personality', type: 'textarea' },
      { key: 'bio', label: 'entities.biography', type: 'textarea' },
      { key: 'history', label: 'entities.personalHistory', type: 'textarea' },
      { key: 'motivation', label: 'entities.motivation', type: 'textarea' },
      { key: 'relationshipNotes', label: 'entities.relationshipNotes', type: 'textarea' },
      { key: 'notes', label: 'entities.notes', type: 'textarea' }
    ]
  },
  locations: {
    listEl: '#locList',
    empty: () => ({ id: uuid(), name: '', type: 'city', description: '', history: '', atmosphere: '', notes: '' }),
    subtitle: e => subtitleOf({ city: 'entities.typeCity', building: 'entities.typeBuilding', natural: 'entities.typeNatural', other: 'entities.typeOther' }, e.type),
    fields: [
      { key: 'name', label: 'entities.nameOfPlace', type: 'input' },
      { key: 'type', label: 'entities.type', type: 'select', options: [['city', 'entities.typeCity'], ['building', 'entities.typeBuilding'], ['natural', 'entities.typeNatural'], ['other', 'entities.typeOther']] },
      { key: 'description', label: 'entities.description', type: 'textarea' },
      { key: 'history', label: 'entities.history', type: 'textarea' },
      { key: 'atmosphere', label: 'entities.atmosphere', type: 'textarea' },
      { key: 'notes', label: 'entities.notes', type: 'textarea' }
    ]
  },
  races: {
    listEl: '#raceList',
    empty: () => ({ id: uuid(), name: '', description: '', appearance: '', culture: '', history: '', traits: '' }),
    subtitle: () => '',
    fields: [
      { key: 'name', label: 'entities.nameOfPlace', type: 'input' },
      { key: 'description', label: 'entities.description', type: 'textarea' },
      { key: 'appearance', label: 'entities.appearance', type: 'textarea' },
      { key: 'culture', label: 'entities.culture', type: 'textarea' },
      { key: 'history', label: 'entities.history', type: 'textarea' },
      { key: 'traits', label: 'entities.specialTraits', type: 'textarea' }
    ]
  }
};

export function renderEntities(kind) {
  const def = ENTITY_DEFS[kind];
  const host = $(def.listEl);
  host.innerHTML = '';
  if (!novel) return;
  novel[kind].forEach(item => {
    const wrap = document.createElement('div');
    wrap.className = 'entity';
    const head = document.createElement('div');
    head.className = 'entity-head';
    head.innerHTML = `<span class="ename">${esc(item.name || t('entities.unnamed'))}</span><span class="erole">${esc(def.subtitle(item))}</span>`;
    head.addEventListener('click', () => wrap.classList.toggle('open'));
    const body = document.createElement('div');
    body.className = 'entity-body';
    def.fields.forEach(f => {
      const lab = document.createElement('label');
      lab.className = 'field-label';
      lab.textContent = t(f.label);
      body.appendChild(lab);
      let ctrl;
      if (f.type === 'textarea') ctrl = document.createElement('textarea');
      else if (f.type === 'select') {
        ctrl = document.createElement('select');
        f.options.forEach(([v, k]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = t(k);
          ctrl.appendChild(o);
        });
      } else {
        ctrl = document.createElement('input');
        ctrl.type = 'text';
      }
      ctrl.value = item[f.key] || '';
      ctrl.addEventListener('input', () => {
        item[f.key] = ctrl.value;
        if (f.key === 'name') head.querySelector('.ename').textContent = ctrl.value || t('entities.unnamed');
        if (f.key === 'role' || f.key === 'type') head.querySelector('.erole').textContent = def.subtitle(item);
        if (kind === 'characters' || kind === 'locations') updateSceneMeta();
        if (kind === 'characters' && graphOpen) drawGraph();
        markDirty();
      });
      body.appendChild(ctrl);
    });
    const del = document.createElement('button');
    del.className = 'entity-del';
    del.textContent = t('common.delete');
    del.addEventListener('click', () => {
      confirmModal(t('common.delete'), t('entities.deleteConfirm', { name: item.name || t('entities.thisEntry') }), () => {
        novel[kind] = novel[kind].filter(x => x.id !== item.id);
        if (kind === 'characters') {
          // scrub references to the removed character
          novel.characters.forEach(c => { c.relationships = (c.relationships || []).filter(r => r.targetCharacterId !== item.id); });
          novel.chapters.forEach(c => (c.scenes || []).forEach(s => { if (s.povCharacter === item.id) s.povCharacter = null; }));
        }
        if (kind === 'locations') novel.chapters.forEach(c => (c.scenes || []).forEach(s => { if (s.location === item.id) s.location = null; }));
        renderEntities(kind);
        updateSceneMeta();
        if (graphOpen) { renderLegend(); drawGraph(); }
        markDirty();
        toast(t('entities.deleted'));
      });
    });
    body.appendChild(del);
    wrap.appendChild(head);
    wrap.appendChild(body);
    host.appendChild(wrap);
  });
  if (kind === 'characters' || kind === 'locations') updateSceneMeta();
}
function addEntity(kind) {
  if (!novel) return;
  novel[kind].push(ENTITY_DEFS[kind].empty());
  renderEntities(kind);
  markDirty();
  const host = $(ENTITY_DEFS[kind].listEl);
  host.lastElementChild.classList.add('open');
}

export function init() {
  $('#btnAddChar').addEventListener('click', () => addEntity('characters'));
  $('#btnAddLoc').addEventListener('click', () => addEntity('locations'));
  $('#btnAddRace').addEventListener('click', () => addEntity('races'));
}
