import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { db, executeQuery, executeBatch, seedTables, saveConsultationTransaction, saveProduct, saveProducts, savePatient, restoreLegacyIndexedDBData, getTableName, MASTER_LICENSE_KEY } from './db';
import { Patient, Anamnesis, Product, Consultation, ConsultationStep, Prescription, ConsultationState } from './types';
import { validateStateTransition } from './stateMachine';
import { decryptData, sha256 } from './crypto';
import { ClinicalReportPDF } from './ClinicalReportPDF';
import { pdf } from '@react-pdf/renderer';
import Fuse from 'fuse.js';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { 
  Activity, Award, Beaker, CheckCircle, ChevronDown, Clipboard, Clock, CloudDownload, 
  Database, FileText, FileUp, FolderHeart, Info, Layers, Lock, Moon, Plus, Printer, 
  Save, Search, Sparkles, Sun, Trash2, User, UserCheck, Wand2, Bug, MessageSquare, X, Send, Edit, Pencil, Eye, AlertTriangle, Check, ShieldAlert, ShieldCheck, Calendar, Droplets, Key, CreditCard, Maximize2
} from 'lucide-react';
import { sendManualReport } from './errorHandler';
import { LAYERING_CATEGORIES, getLayerOrder, analyzePrescriptionSafety, generateSuggestedHomeRoutine, parseStringList, getDefaultDosageInstructions, getDefaultApplicationFrequency } from './cosmetologyLogic';
import { BeforeAfterSlider, parseImageList, serializeImageList } from './BeforeAfterSlider';
import { BackupModal } from './BackupModal';
import { TrashModal } from './TrashModal';
import { SignatureKioskModal } from './SignaturePad';
import { isTouchPrimaryDevice, getOrCreateDeviceId } from './deviceUtils';

// Clave de localStorage para el borrador automático de la Ficha de Diagnóstico en curso (ver
// useEffects de autoguardado/restauración cerca de resetPatientForm). Persiste solo en este
// dispositivo/navegador; no viaja a Turso.
const FICHA_DRAFT_KEY = 'dermatique_ficha_draft_v1';

const FASE_CATEGORY_MAPPING: Record<string, string[]> = {
  "Limpieza": ["Limpiador"],
  "Shampoo": ["Limpiador"],
  "Exfoliación": ["Exfoliante"],
  "Peeling": ["Exfoliante", "Peeling"],
  "Tonificación": ["Regulador pH", "Loción"],
  "Armonizador": ["Armonizador", "Regulador pH", "Loción", "Crema/Gel"],
  "Principio Activo": ["Serum/Vial", "Específico"],
  "Sérum": ["Serum/Vial", "Suero", "Sérum"],
  "Activo": ["Serum/Vial", "Específico", "Concentrado"],
  "Mascarilla": ["Mascarilla"],
  "Crema de Sellado": ["Crema/Gel"],
  "Protección Solar": ["Crema/Gel", "Específico", "Biobotulina"],
  "Apoyo en Casa": ["Alternative", "Rosa Mosq.", "Mulike", "Oro", "Clásica", "Diamante", "Biohelicina", "Biobotulina"]
};

export const DEFAULT_PRODUCT_TYPES = [
  'Aceite',
  'Ampolleta',
  'Armonizador',
  'Bálsamo',
  'Bloqueador Solar',
  'Contorno de Ojos',
  'Contorno de Labios',
  'Crema',
  'Elixir',
  'Emulsión',
  'Escultor',
  'Espuma',
  'Exfoliante',
  'Fotoprotector',
  'Gel',
  'Gel Limpiador',
  'Insumo de Masaje',
  'Leche Limpiadora',
  'Limpiador',
  'Loción',
  'Mascarilla',
  'Peeling',
  'Plastificante',
  'Scrub',
  'Sérum',
  'Suero',
  'Tónico'
];

export function inferProductType(name: string, brandLine?: string): string {
  const norm = ((name || '') + ' ' + (brandLine || '')).toLowerCase();
  if (norm.includes('shampoo') || norm.includes('limpia') || norm.includes('gel limpiador') || norm.includes('leche') || norm.includes('espuma')) return 'Limpiador / Gel / Leche';
  if (norm.includes('tónic') || norm.includes('tonic') || norm.includes('loción') || norm.includes('locion') || norm.includes('armonizador')) return 'Tónico / Loción / Armonizador';
  if (norm.includes('exfolia') || norm.includes('peeling') || norm.includes('scrub') || norm.includes('ácido') || norm.includes('glicólico')) return 'Exfoliante / Peeling / Scrub';
  if (norm.includes('suero') || norm.includes('serum') || norm.includes('ampolleta') || norm.includes('concentrado') || norm.includes('elixir')) return 'Suero / Sérum / Ampolleta';
  if (norm.includes('mascarilla') || norm.includes('mask') || norm.includes('plástic') || norm.includes('alginato')) return 'Mascarilla / Plastificante';
  if (norm.includes('crema') || norm.includes('emulsión') || norm.includes('emulsion') || norm.includes('bálsamo') || norm.includes('hidratante') || norm.includes('noche')) return 'Crema / Emulsión / Bálsamo';
  if (norm.includes('ojos') || norm.includes('ocular') || norm.includes('contorno') || norm.includes('labios')) return 'Contorno de Ojos / Labios';
  if (norm.includes('solar') || norm.includes('pantalla') || norm.includes('bloqueador') || norm.includes('spf') || norm.includes('fotoprotec')) return 'Fotoprotector / Bloqueador Solar';
  if (norm.includes('aceite') || norm.includes('masaje') || norm.includes('vehicular')) return 'Aceite / Insumo de Masaje';
  return 'General';
}

// Mismo criterio de deduplicación que ya usa `seedTablesImpl` en db.ts para la migración legada
// de `productos_activos`: mismo nombre + misma marca (sin importar mayúsculas) se considera el
// mismo producto ya existente en el catálogo.
function isDuplicateProduct(p: Product, existing: Product[]): boolean {
  const key = `${p.name.trim().toLowerCase()}_${(p.brandLine || '').trim().toLowerCase()}`;
  return existing.some(e => `${e.name.trim().toLowerCase()}_${(e.brandLine || '').trim().toLowerCase()}` === key);
}

function parseMoneyValue(val: any): number {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[^0-9.\-]/g, '');
  return parseFloat(cleaned) || 0;
}

export function productMatchesBiotype(p: Product, biotype: string): boolean {
  if (!biotype) return false;
  const list = parseStringList(p.skinBiotypes);
  return list.some(b => b.toLowerCase() === biotype.toLowerCase());
}

// Ordena por coincidencia de biotipo sin descartar nada más (orden estable: dentro de cada
// grupo se conserva el orden de relevancia/búsqueda original).
function sortByBiotypeMatch(items: Product[], biotype: string): Product[] {
  if (!biotype) return items;
  return [...items].sort((a, b) => Number(productMatchesBiotype(b, biotype)) - Number(productMatchesBiotype(a, biotype)));
}

interface SuggestFieldProps {
  label?: string;
  value: string;
  onChange: (val: string) => void;
  options: string[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
  emptyLabel?: string;
  addNewLabel?: string;
  inputClassName?: string;
}

// Combobox genérico reutilizable: texto libre + desplegable filtrado con lo ya capturado en la
// base + opción de "agregar nuevo". Generalizado a partir del selector de Tipo/Formato de
// producto (único caso original) para no duplicar esta misma lógica de dropdown en cada campo
// de texto libre que se repite entre fichas (marca, protocolo, alergias, condiciones médicas...).
function SuggestField({ label, value, onChange, options, placeholder, required, hint, emptyLabel, addNewLabel, inputClassName }: SuggestFieldProps) {
  const [search, setSearch] = useState(value || '');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSearch(value || '');
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter(t => t.toLowerCase().includes(q));
  }, [search, options]);

  const exactMatch = options.some(t => t.toLowerCase() === search.trim().toLowerCase());

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5 relative w-full">
      {label && (
        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1 flex items-center justify-between">
          <span>{label}</span>
          {hint !== '' && <span className="text-[9px] text-amber-600 dark:text-amber-400 font-semibold">{hint || 'Autocompletado'}</span>}
        </label>
      )}

      <input
        type="text"
        value={search}
        onChange={e => {
          setSearch(e.target.value);
          onChange(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        placeholder={placeholder}
        required={required}
        className={inputClassName || 'smart-input w-full font-semibold text-slate-800 dark:text-white'}
      />

      {isOpen && (filtered.length > 0 || search.trim().length > 0) && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-luxe-900 shadow-2xl max-h-56 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5 animate-fade-in">
          {filtered.length > 0 && (
            <div className="px-3 py-1.5 bg-slate-50 dark:bg-white/5 text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between sticky top-0 backdrop-blur-md z-10 border-b border-slate-100 dark:border-white/5">
              <span>{emptyLabel || 'Registrados'} ({filtered.length})</span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white font-bold text-xs"
              >
                ✕
              </button>
            </div>
          )}

          {filtered.map(t => (
            <div
              key={t}
              onClick={() => {
                onChange(t);
                setSearch(t);
                setIsOpen(false);
              }}
              className="p-2.5 hover:bg-amber-500/10 dark:hover:bg-white/5 cursor-pointer text-xs transition-colors flex items-center justify-between group"
            >
              <span className="font-semibold text-slate-800 dark:text-white group-hover:text-amber-600 dark:group-hover:text-amber-400">
                {t}
              </span>
              {value === t && <Check className="w-3.5 h-3.5 text-amber-500" />}
            </div>
          ))}

          {!exactMatch && search.trim().length > 0 && (
            <div
              onClick={() => {
                const newVal = search.trim();
                onChange(newVal);
                setSearch(newVal);
                setIsOpen(false);
              }}
              className="p-3 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 font-bold text-xs cursor-pointer flex items-center gap-2 transition-colors border-t border-amber-500/30"
            >
              <Plus className="w-4 h-4 text-amber-500" />
              <span>{addNewLabel || 'Agregar'} "{search.trim()}"</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface SuggestChipsProps {
  value: string;
  onChange: (val: string) => void;
  options: string[];
  maxChips?: number;
}

// Sugerencias en píldoras para campos de texto libre separados por comas (activos, acciones):
// a diferencia de SuggestField, no reemplazan el valor completo — añaden el texto elegido al
// final de la lista, filtradas por lo que se está escribiendo tras la última coma.
function SuggestChips({ value, onChange, options, maxChips = 6 }: SuggestChipsProps) {
  const segments = value.split(',');
  const lastSegment = (segments[segments.length - 1] || '').trim().toLowerCase();

  const matches = useMemo(() => {
    const already = new Set(segments.map(s => s.trim().toLowerCase()).filter(Boolean));
    const pool = lastSegment
      ? options.filter(o => o.toLowerCase().includes(lastSegment))
      : options;
    return pool.filter(o => !already.has(o.toLowerCase())).slice(0, maxChips);
  }, [options, lastSegment, value, maxChips]);

  if (matches.length === 0) return null;

  const appendChip = (chip: string) => {
    const prefix = segments.slice(0, -1).map(s => s.trim()).filter(Boolean);
    onChange([...prefix, chip].join(', '));
  };

  return (
    <div className="flex flex-wrap gap-1.5 -mt-1">
      {matches.map(m => (
        <button
          key={m}
          type="button"
          onClick={() => appendChip(m)}
          className="px-2 py-1 rounded-full text-[10px] font-semibold bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-luxe-300 border border-slate-200/50 dark:border-white/10 hover:bg-amber-500/10 hover:border-amber-500/40 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
        >
          + {m}
        </button>
      ))}
    </div>
  );
}

interface SmartCatalogSelectorProps {
  stepName: string;
  defaultProductName: string;
  selectedProductId: string;
  products: Product[];
  matches: Product[];
  onSelect: (productId: string) => void;
  biotype?: string;
}

function SmartCatalogSelector({ stepName, defaultProductName, selectedProductId, products, matches, onSelect, biotype = '' }: SmartCatalogSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const autoProduct = selectedProductId !== 'default' 
    ? products.find(p => p.id === selectedProductId) 
    : (matches.length > 0 ? matches[0] : null);

  const selectedDisplay = autoProduct
    ? `✨ ${autoProduct.name} (${autoProduct.brandLine})`
    : `✨ Base: ${defaultProductName}`;

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = !q ? products : products.filter(p => {
      const activesStr = typeof p.activeIngredients === 'string' ? p.activeIngredients : JSON.stringify(p.activeIngredients);
      return p.name.toLowerCase().includes(q) || p.brandLine.toLowerCase().includes(q) || activesStr.toLowerCase().includes(q);
    });
    return sortByBiotypeMatch(base, biotype);
  }, [search, products, biotype]);

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-luxe-900 border border-amber-500/40 dark:border-amber-500/30 text-slate-800 dark:text-white shadow-sm hover:border-amber-500 transition-all text-left"
      >
        <span className="truncate flex-1 font-bold">{selectedDisplay}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-amber-500 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-80 md:w-96 rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-luxe-900 shadow-2xl p-2.5 space-y-2 animate-fade-in max-h-[360px] flex flex-col">
          <div className="relative shrink-0">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="🔍 Escriba para buscar por marca, nombre o activo..."
              className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-800 dark:text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
              autoFocus
            />
          </div>

          <div className="flex-1 overflow-y-auto max-h-[260px] pr-1 space-y-2 scrollbar-thin text-xs">
            {!search && matches.length > 0 && (
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 px-2 block mb-1">
                  ✨ Recomendación Auto-Asociada
                </span>
                <div
                  onClick={() => {
                    onSelect('default');
                    setIsOpen(false);
                  }}
                  className={`p-2 rounded-xl cursor-pointer transition-colors flex items-center justify-between ${
                    selectedProductId === 'default'
                      ? 'bg-amber-500/15 font-bold text-amber-700 dark:text-amber-300 border border-amber-500/30'
                      : 'hover:bg-slate-100 dark:hover:bg-white/5 text-slate-700 dark:text-luxe-200'
                  }`}
                >
                  <div>
                    <span className="block font-bold">{matches[0].name}</span>
                    <span className="text-[10px] opacity-75">{matches[0].brandLine}</span>
                  </div>
                  {selectedProductId === 'default' && <Check className="w-3.5 h-3.5 text-amber-500" />}
                </div>
              </div>
            )}

            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 px-2 block mb-1">
                🛒 Productos del Catálogo ({filteredProducts.length})
              </span>
              {filteredProducts.length === 0 ? (
                <p className="text-[11px] text-slate-400 italic px-2 py-3">No se encontraron productos coincidentes.</p>
              ) : (
                filteredProducts.map(p => {
                  const isSel = selectedProductId === p.id;
                  let activesText = '';
                  try {
                    const parsed = JSON.parse(p.activeIngredients || '[]');
                    activesText = Array.isArray(parsed) ? parsed.join(', ') : p.activeIngredients;
                  } catch(e) {
                    activesText = p.activeIngredients;
                  }

                  return (
                    <div
                      key={p.id}
                      onClick={() => {
                        onSelect(p.id);
                        setIsOpen(false);
                      }}
                      className={`p-2 rounded-xl cursor-pointer transition-colors flex items-center justify-between border-b border-slate-100 dark:border-white/5 last:border-0 ${
                        isSel
                          ? 'bg-amber-500/15 font-bold text-amber-700 dark:text-amber-300 border border-amber-500/30'
                          : 'hover:bg-slate-100 dark:hover:bg-white/5 text-slate-700 dark:text-luxe-200'
                      }`}
                    >
                      <div className="space-y-0.5 max-w-[85%]">
                        <span className="font-bold text-slate-800 dark:text-white truncate flex items-center gap-1.5">
                          {p.name}
                          {productMatchesBiotype(p, biotype) && (
                            <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 shrink-0">✓ Biotipo</span>
                          )}
                        </span>
                        <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold block">{p.brandLine}</span>
                        {activesText && <span className="text-[9.5px] text-slate-400 truncate block">{activesText}</span>}
                      </div>
                      {isSel && <Check className="w-4 h-4 text-amber-500 shrink-0" />}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Mapa Facial Clínico Interactivo: usa la foto de referencia real del cliente (public/mapa_facial_
// referencia.png, 912x1146) como fondo. Estas zonas fueron trazadas a mano por el usuario sobre esa
// misma foto con una herramienta dedicada, calcando exactamente los contornos punteados de la imagen.
const FACIAL_ZONES: Record<string, { label: string; d: string }> = {
  sienDerecha: { label: 'Sien derecha', d: 'M 394.2,467.1 C 394.2,467.1 374.2,450.0 374.2,450.0 C 374.2,450.0 350.0,431.5 350.0,431.5 C 350.0,431.5 330.0,415.8 330.0,415.8 C 330.0,415.8 311.5,401.6 311.5,401.6 C 311.5,401.6 287.3,381.6 287.3,381.6 C 287.3,381.6 271.6,367.4 271.6,367.4 C 271.6,367.4 253.1,353.1 253.1,353.1 C 253.1,353.1 240.3,340.3 240.3,340.3 C 240.3,340.3 226.0,326.0 226.0,326.0 C 226.0,326.0 213.2,308.9 213.2,308.9 C 213.2,308.9 207.5,293.3 207.5,293.3 C 207.5,293.3 206.1,281.9 206.1,281.9 C 206.1,281.9 206.1,269.0 206.1,269.0 C 206.1,269.0 208.9,256.2 208.9,256.2 C 208.9,256.2 211.8,243.4 211.8,243.4 C 211.8,243.4 210.3,237.7 210.3,237.7 C 210.3,237.7 206.1,230.6 206.1,230.6 C 206.1,230.6 198.9,229.1 198.9,229.1 C 198.9,229.1 193.2,229.1 193.2,229.1 C 193.2,229.1 186.1,232.0 186.1,232.0 C 186.1,232.0 180.4,234.8 180.4,234.8 C 180.4,234.8 176.1,237.7 176.1,237.7 C 176.1,237.7 170.4,242.0 170.4,242.0 C 170.4,242.0 166.2,246.2 166.2,246.2 C 166.2,246.2 161.9,253.4 161.9,253.4 C 161.9,253.4 156.2,260.5 156.2,260.5 C 156.2,260.5 153.3,267.6 153.3,267.6 C 153.3,267.6 149.1,274.7 149.1,274.7 C 149.1,274.7 143.4,286.1 143.4,286.1 C 143.4,286.1 139.1,300.4 139.1,300.4 C 139.1,300.4 133.4,314.6 133.4,314.6 C 133.4,314.6 127.7,328.9 127.7,328.9 C 127.7,328.9 124.8,341.7 124.8,341.7 C 124.8,341.7 123.4,353.1 123.4,353.1 C 123.4,353.1 122.0,367.4 122.0,367.4 C 122.0,367.4 122.0,377.3 122.0,377.3 C 122.0,377.3 123.4,384.5 123.4,384.5 C 123.4,384.5 129.1,387.3 129.1,387.3 C 129.1,387.3 134.8,385.9 134.8,385.9 C 134.8,385.9 141.9,381.6 141.9,381.6 C 141.9,381.6 151.9,383.0 151.9,383.0 C 151.9,383.0 164.7,383.0 164.7,383.0 C 164.7,383.0 176.1,384.5 176.1,384.5 C 176.1,384.5 187.5,385.9 187.5,385.9 C 187.5,385.9 201.8,387.3 201.8,387.3 C 201.8,387.3 213.2,390.2 213.2,390.2 C 213.2,390.2 224.6,391.6 224.6,391.6 C 224.6,391.6 238.8,395.9 238.8,395.9 C 238.8,395.9 253.1,398.7 253.1,398.7 C 253.1,398.7 267.3,403.0 267.3,403.0 C 267.3,403.0 278.7,407.3 278.7,407.3 C 278.7,407.3 293.0,414.4 293.0,414.4 C 293.0,414.4 304.4,421.5 304.4,421.5 C 304.4,421.5 315.8,427.2 315.8,427.2 C 315.8,427.2 325.8,432.9 325.8,432.9 C 325.8,432.9 337.2,438.6 337.2,438.6 C 337.2,438.6 347.1,447.2 347.1,447.2 C 347.1,447.2 360.0,455.7 360.0,455.7 C 360.0,455.7 368.5,461.4 368.5,461.4 C 368.5,461.4 378.5,468.5 378.5,468.5 C 378.5,468.5 387.0,472.8 387.0,472.8 C 387.0,472.8 392.7,475.7 392.7,475.7 C 392.7,475.7 395.6,472.8 395.6,472.8 C 395.6,472.8 394.2,468.5 394.2,468.5 C 394.2,468.5 394.2,467.1 394.2,467.1 C 394.2,467.1 394.2,467.1 394.2,467.1 Z' },
  frente: { label: 'Frente', d: 'M 431.2,238.2 C 397.5,236.7 347.4,232.2 318.6,229.6 C 289.9,227.0 274.5,219.6 258.8,222.5 C 243.1,225.3 229.8,234.4 224.6,246.7 C 219.4,259.1 218.6,278.3 227.4,296.6 C 236.2,314.9 260.0,339.3 277.3,356.4 C 294.6,373.5 311.5,384.9 331.5,399.2 C 351.4,413.4 379.4,432.2 397.0,441.9 C 414.6,451.7 419.6,460.7 436.9,457.6 C 454.2,454.5 481.6,436.9 501.0,423.4 C 520.5,409.9 537.8,392.3 553.8,376.4 C 569.7,360.5 585.1,343.4 596.5,327.9 C 607.9,312.5 618.1,297.5 622.2,283.8 C 626.2,270.0 625.7,254.3 620.7,245.3 C 615.7,236.3 608.9,230.8 592.2,229.6 C 575.6,228.4 547.8,236.7 521.0,238.2 C 494.1,239.6 464.9,239.6 431.2,238.2 Z' },
  puenteDeNariz: { label: 'Puente de nariz', d: 'M 435.5,482.1 C 426.7,483.1 414.1,490.0 407.0,496.4 C 399.9,502.8 395.6,511.8 392.7,520.6 C 389.9,529.4 388.7,540.3 389.9,549.1 C 391.1,557.9 395.3,566.2 399.9,573.3 C 404.4,580.4 409.6,587.8 417.0,591.8 C 424.3,595.9 435.7,598.5 444.0,597.5 C 452.3,596.6 461.1,590.9 466.8,586.1 C 472.5,581.4 475.4,577.1 478.2,569.0 C 481.1,561.0 484.2,547.2 483.9,537.7 C 483.7,528.2 480.8,519.9 476.8,512.0 C 472.8,504.2 466.6,495.7 459.7,490.7 C 452.8,485.7 444.3,481.2 435.5,482.1 Z' },
  sienIzquierda: { label: 'Sien izquierda', d: 'M 640.7,228.2 C 633.6,229.4 637.6,235.3 637.8,248.1 C 638.1,261.0 645.2,288.7 642.1,305.1 C 639.0,321.5 630.7,332.2 619.3,346.5 C 607.9,360.7 597.2,370.4 573.7,390.6 C 550.2,410.8 492.0,454.0 478.2,467.6 C 464.5,481.1 474.7,480.2 491.1,471.9 C 507.4,463.5 542.6,432.4 576.6,417.7 C 610.5,403.0 667.5,390.0 694.8,383.5 C 722.1,377.0 732.8,385.4 740.4,378.7 C 748.0,371.9 744.2,357.2 740.4,343.0 C 736.6,328.9 727.6,310.7 717.6,293.7 C 707.7,276.7 693.4,251.9 680.6,241.0 C 667.8,230.1 647.8,227.0 640.7,228.2 Z' },
  lateralDerecho: { label: 'Lateral derecho', d: 'M 92.1,483.3 C 90.6,511.9 83.0,611.2 90.6,639.7 C 98.2,668.2 130.1,651.9 137.7,654.3 C 145.3,656.6 135.5,656.1 136.2,654.0 C 136.9,651.8 145.3,650.7 141.9,641.4 C 138.6,632.2 121.7,608.4 116.3,598.4 C 110.8,588.4 110.6,588.4 109.2,581.3 C 107.7,574.2 106.8,564.6 107.7,555.7 C 108.7,546.7 112.5,537.4 114.9,527.4 C 117.2,517.5 121.5,505.1 122.0,496.1 C 122.5,487.1 121.5,478.0 117.7,473.3 C 113.9,468.5 103.5,465.9 99.2,467.6 C 94.9,469.2 93.5,454.6 92.1,483.3 Z' },
  lateralIzquierdo: { label: 'Lateral izquierdo', d: 'M 781.8,495.5 C 780.6,467.5 782.9,472.2 778.9,469.9 C 774.9,467.5 761.6,474.9 757.5,481.3 C 753.5,487.7 753.7,495.8 754.7,508.3 C 755.6,520.9 761.3,543.3 763.2,556.8 C 765.1,570.3 768.2,579.8 766.1,589.6 C 763.9,599.3 755.9,605.7 750.4,615.2 C 744.9,624.7 735.9,639.4 733.3,646.6 C 730.7,653.7 732.1,655.1 734.7,658.0 C 737.3,660.8 740.4,667.0 749.0,663.7 C 757.5,660.3 780.6,666.0 786.0,638.0 C 791.5,610.0 782.9,523.5 781.8,495.5 Z' },
  cejaIzquierda: { label: 'Ceja izquierda', d: 'M 499.6,494.9 C 502.0,490.9 527.2,459.6 549.5,445.1 C 571.8,430.6 605.3,415.1 633.6,408.0 C 661.8,400.9 698.6,398.8 719.1,402.3 C 739.5,405.9 751.1,418.2 756.1,429.4 C 761.1,440.6 760.4,467.2 749.0,469.3 C 737.6,471.4 709.8,447.2 687.7,442.2 C 665.6,437.2 641.9,434.9 616.5,439.4 C 591.0,443.9 554.7,460.0 535.2,469.3 C 515.8,478.6 497.2,499.0 499.6,494.9 Z' },
  cejaDerecha: { label: 'Ceja derecha', d: 'M 377.1,494.1 C 376.1,490.8 348.3,459.9 330.0,447.1 C 311.7,434.2 288.7,424.7 267.3,417.1 C 246.0,409.5 222.0,403.4 201.8,401.5 C 181.6,399.6 160.7,400.0 146.2,405.7 C 131.7,411.4 117.5,424.7 114.9,435.7 C 112.2,446.6 124.1,468.0 130.5,471.3 C 136.9,474.6 140.3,461.1 153.3,455.6 C 166.4,450.2 187.1,440.2 208.9,438.5 C 230.8,436.9 263.3,440.9 284.4,445.6 C 305.6,450.4 320.3,458.9 335.7,467.0 C 351.2,475.1 378.0,497.4 377.1,494.1 Z' },
  zonaDeOjerasDerecha: { label: 'Zona de ojeras derecha', d: 'M 230.3,467.0 C 204.6,468.0 174.5,476.5 156.2,489.8 C 137.9,503.1 122.2,523.1 120.6,546.8 C 118.9,570.6 128.9,610.9 146.2,632.3 C 163.5,653.7 196.3,670.8 224.6,675.1 C 252.8,679.3 290.8,670.8 315.8,658.0 C 340.7,645.1 366.1,620.2 374.2,598.1 C 382.3,576.0 374.9,544.4 364.2,525.4 C 353.5,506.4 332.4,493.9 310.1,484.1 C 287.8,474.4 255.9,466.1 230.3,467.0 Z' },
  zonaDeOjerasIzquierda: { label: 'Zona de ojeras izquierda', d: 'M 622.2,467.0 C 597.9,469.9 562.5,480.8 542.4,492.7 C 522.2,504.5 508.2,519.3 501.0,538.3 C 493.9,557.3 490.1,587.0 499.6,606.7 C 509.1,626.4 533.6,645.4 558.0,656.5 C 582.5,667.7 619.8,676.5 646.4,673.6 C 673.0,670.8 700.8,656.5 717.6,639.4 C 734.5,622.3 743.8,591.9 747.6,571.0 C 751.4,550.1 750.4,530.0 740.4,514.0 C 730.5,498.1 707.4,483.4 687.7,475.6 C 668.0,467.7 646.4,464.2 622.2,467.0 Z' },
  pomuloDerecho: { label: 'Pómulo derecho', d: 'M 358.5,646.6 C 369.0,640.4 371.4,635.9 375.6,638.0 C 379.9,640.2 385.6,649.9 384.2,659.4 C 382.8,668.9 376.1,683.4 367.1,695.0 C 358.1,706.7 349.5,717.1 330.0,729.2 C 310.6,741.3 276.1,760.1 250.2,767.7 C 224.3,775.3 193.9,778.6 174.7,774.8 C 155.5,771.0 144.5,757.0 134.8,744.9 C 125.1,732.8 117.7,714.7 116.3,702.1 C 114.9,689.6 119.4,675.5 126.3,669.4 C 133.1,663.2 144.1,662.7 157.6,665.1 C 171.1,667.5 190.9,680.1 207.5,683.6 C 224.1,687.2 239.8,687.9 257.4,686.5 C 274.9,685.0 296.1,681.7 312.9,675.1 C 329.8,668.4 348.1,652.7 358.5,646.6 Z' },
  pomuloIzquierdo: { label: 'Pómulo izquierdo', d: 'M 509.6,638.0 C 499.8,635.6 496.3,646.3 495.3,653.7 C 494.4,661.1 498.2,672.7 503.9,682.2 C 509.6,691.7 514.3,698.6 529.5,710.7 C 544.7,722.8 571.3,743.7 595.1,754.9 C 618.8,766.0 650.2,776.0 672.0,777.7 C 693.9,779.3 711.5,775.3 726.2,764.8 C 740.9,754.4 755.2,730.4 760.4,715.0 C 765.6,699.5 764.4,680.3 757.5,672.2 C 750.6,664.1 735.9,664.1 719.1,666.5 C 702.2,668.9 676.5,683.6 656.4,686.5 C 636.2,689.3 615.0,686.7 597.9,683.6 C 580.8,680.5 568.5,675.5 553.8,667.9 C 539.0,660.3 519.3,640.4 509.6,638.0 Z' },
  nariz: { label: 'Nariz', d: 'M 438.3,620.9 C 430.3,621.4 421.9,626.9 412.7,638.0 C 403.4,649.2 390.8,670.3 382.8,687.9 C 374.7,705.5 364.5,733.0 364.2,743.5 C 364.0,753.9 372.8,752.0 381.3,750.6 C 389.9,749.2 402.2,737.8 415.5,734.9 C 428.8,732.1 446.2,730.2 461.1,733.5 C 476.1,736.8 496.0,753.2 505.3,754.9 C 514.6,756.5 518.8,755.6 516.7,743.5 C 514.6,731.4 501.7,700.2 492.5,682.2 C 483.2,664.1 470.2,645.4 461.1,635.2 C 452.1,625.0 446.4,620.4 438.3,620.9 Z' },
  arcoDeCupido: { label: 'Arco de cupido', d: 'M 434.1,810.4 C 412.7,810.4 389.9,815.0 372.8,819.0 C 355.7,823.0 343.3,827.3 331.5,834.7 C 319.6,842.0 308.7,853.2 301.5,863.2 C 294.4,873.1 289.7,886.0 288.7,894.5 C 287.8,903.1 291.8,911.4 295.8,914.5 C 299.9,917.6 302.5,918.7 312.9,913.0 C 323.4,907.3 344.5,890.0 358.5,880.3 C 372.5,870.5 384.7,857.9 397.0,854.6 C 409.4,851.3 421.0,860.6 432.6,860.3 C 444.3,860.1 455.7,851.3 466.8,853.2 C 478.0,855.1 487.3,863.4 499.6,871.7 C 512.0,880.0 528.8,895.7 540.9,903.1 C 553.0,910.4 565.9,916.8 572.3,915.9 C 578.7,914.9 579.9,905.7 579.4,897.4 C 578.9,889.1 575.8,876.0 569.4,866.0 C 563.0,856.0 552.3,845.4 540.9,837.5 C 529.5,829.7 518.8,823.5 501.0,819.0 C 483.2,814.5 455.4,810.4 434.1,810.4 Z' },
  surcoNasoGenianoDerecho: { label: 'Surco naso geniano derecho', d: 'M 340.0,773.4 C 336.7,767.9 331.7,762.2 324.3,760.6 C 317.0,758.9 305.6,759.9 295.8,763.4 C 286.1,767.0 273.5,773.6 265.9,781.9 C 258.3,790.3 254.3,802.1 250.2,813.3 C 246.2,824.5 243.6,836.8 241.7,848.9 C 239.8,861.0 239.1,874.3 238.8,886.0 C 238.6,897.6 236.5,912.6 240.3,918.7 C 244.1,924.9 256.4,928.7 261.6,923.0 C 266.9,917.3 267.1,896.4 271.6,884.5 C 276.1,872.7 280.9,862.9 288.7,851.8 C 296.5,840.6 309.4,827.3 318.6,817.6 C 327.9,807.8 340.7,800.7 344.3,793.3 C 347.8,786.0 343.3,778.9 340.0,773.4 Z' },
  surcoNasoGenianoIzquierdo: { label: 'Surco naso geniano izquierdo', d: 'M 529.5,763.4 C 534.0,758.4 542.8,757.2 549.5,756.3 C 556.1,755.3 562.5,755.6 569.4,757.7 C 576.3,759.9 584.4,763.9 590.8,769.1 C 597.2,774.3 603.2,781.2 607.9,789.1 C 612.7,796.9 616.2,806.6 619.3,816.1 C 622.4,825.6 624.8,835.9 626.4,846.1 C 628.1,856.3 628.6,868.6 629.3,877.4 C 630.0,886.2 631.2,891.7 630.7,898.8 C 630.2,905.9 630.2,916.6 626.4,920.2 C 622.6,923.7 611.7,923.5 607.9,920.2 C 604.1,916.8 606.0,908.3 603.6,900.2 C 601.3,892.1 598.9,882.2 593.7,871.7 C 588.4,861.3 578.5,846.5 572.3,837.5 C 566.1,828.5 563.0,823.7 556.6,817.6 C 550.2,811.4 539.5,805.7 533.8,800.5 C 528.1,795.2 523.1,792.4 522.4,786.2 C 521.7,780.0 525.0,768.4 529.5,763.4 Z' },
  barbillaMenton: { label: 'Barbilla/Mentón', d: 'M 438.3,1004.2 C 424.3,1004.5 405.8,1006.4 392.7,1009.9 C 379.7,1013.5 369.0,1018.5 360.0,1025.6 C 350.9,1032.7 341.9,1043.7 338.6,1052.7 C 335.3,1061.7 336.2,1072.4 340.0,1079.8 C 343.8,1087.1 351.6,1092.1 361.4,1096.9 C 371.1,1101.6 385.6,1105.7 398.4,1108.3 C 411.3,1110.9 425.3,1112.5 438.3,1112.5 C 451.4,1112.5 465.2,1110.6 476.8,1108.3 C 488.4,1105.9 498.9,1102.1 508.2,1098.3 C 517.4,1094.5 526.7,1091.4 532.4,1085.5 C 538.1,1079.5 542.1,1070.0 542.4,1062.7 C 542.6,1055.3 538.6,1047.9 533.8,1041.3 C 529.1,1034.6 523.4,1028.2 513.9,1022.8 C 504.4,1017.3 489.4,1011.6 476.8,1008.5 C 464.2,1005.4 452.3,1004.0 438.3,1004.2 Z' },
  mandibulaDerecha: { label: 'Mandíbula derecha', d: 'M 228.9,826.1 C 227.9,816.6 225.8,811.6 221.7,806.2 C 217.7,800.7 212.5,796.9 204.6,793.3 C 196.8,789.8 184.9,784.6 174.7,784.8 C 164.5,785.0 149.3,789.3 143.4,794.8 C 137.4,800.2 139.3,808.1 139.1,817.6 C 138.8,827.1 138.6,836.6 141.9,851.8 C 145.3,867.0 150.5,890.7 159.0,908.8 C 167.6,926.8 179.9,944.4 193.2,960.1 C 206.5,975.7 233.4,1002.8 238.8,1002.8 C 244.3,1002.8 228.6,975.7 226.0,960.1 C 223.4,944.4 222.9,924.9 223.2,908.8 C 223.4,892.6 226.5,876.9 227.4,863.2 C 228.4,849.4 229.8,835.6 228.9,826.1 Z' },
  mandibulaIzquierda: { label: 'Mandíbula izquierda', d: 'M 637.8,836.1 C 637.6,824.7 638.8,818.8 642.1,811.9 C 645.4,805.0 651.4,798.6 657.8,794.8 C 664.2,791.0 671.6,789.8 680.6,789.1 C 689.6,788.4 703.9,788.4 711.9,790.5 C 720.0,792.6 726.4,793.6 729.0,801.9 C 731.6,810.2 729.3,828.0 727.6,840.4 C 725.9,852.7 722.6,864.4 719.1,876.0 C 715.5,887.6 710.5,900.0 706.2,910.2 C 702.0,920.4 698.9,928.0 693.4,937.3 C 687.9,946.5 681.1,956.7 673.5,965.8 C 665.9,974.8 654.7,985.0 647.8,991.4 C 640.9,997.8 633.1,1009.9 632.1,1004.2 C 631.2,998.5 640.4,971.9 642.1,957.2 C 643.8,942.5 641.9,928.7 642.1,915.9 C 642.3,903.1 644.2,893.6 643.5,880.3 C 642.8,867.0 638.1,847.5 637.8,836.1 Z' },
  contornoDeMandibula: { label: 'Contorno de mandíbula', d: 'M 441.2,988.6 C 425.3,989.0 409.6,989.5 394.2,985.7 C 378.7,981.9 360.7,971.9 348.6,965.8 C 336.4,959.6 331.5,952.9 321.5,948.7 C 311.5,944.4 298.0,939.6 288.7,940.1 C 279.4,940.6 272.6,946.3 265.9,951.5 C 259.3,956.7 251.9,963.6 248.8,971.5 C 245.7,979.3 245.7,989.3 247.4,998.5 C 249.0,1007.8 253.6,1018.3 258.8,1027.0 C 264.0,1035.8 271.6,1044.4 278.7,1051.3 C 285.9,1058.2 293.0,1063.1 301.5,1068.4 C 310.1,1073.6 325.8,1083.8 330.0,1082.6 C 334.3,1081.4 326.2,1068.6 327.2,1061.2 C 328.1,1053.9 330.5,1045.8 335.7,1038.4 C 341.0,1031.1 348.1,1023.2 358.5,1017.1 C 369.0,1010.9 385.1,1004.2 398.4,1001.4 C 411.7,998.5 425.0,999.7 438.3,1000.0 C 451.6,1000.2 466.4,1000.7 478.2,1002.8 C 490.1,1005.0 499.8,1008.5 509.6,1012.8 C 519.3,1017.1 530.0,1021.6 536.7,1028.5 C 543.3,1035.4 547.6,1045.3 549.5,1054.1 C 551.4,1062.9 543.1,1080.5 548.1,1081.2 C 553.0,1081.9 571.8,1065.3 579.4,1058.4 C 587.0,1051.5 588.0,1045.8 593.7,1039.9 C 599.4,1033.9 608.6,1030.6 613.6,1022.8 C 618.6,1014.9 622.4,1001.4 623.6,992.8 C 624.8,984.3 623.1,977.6 620.7,971.5 C 618.4,965.3 613.4,960.3 609.3,955.8 C 605.3,951.3 602.2,946.8 596.5,944.4 C 590.8,942.0 581.5,941.3 575.1,941.5 C 568.7,941.8 564.7,943.7 558.0,945.8 C 551.4,948.0 541.9,950.8 535.2,954.4 C 528.6,957.9 525.7,962.4 518.1,967.2 C 510.5,971.9 502.5,979.3 489.6,982.9 C 476.8,986.4 457.1,988.1 441.2,988.6 Z' },
};

export default function App() {
  // Authentication & License States (Cloudflare Workers Integrated)
  const [isLogged, setIsLogged] = useState(false);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [licenseDevices, setLicenseDevices] = useState<{ used: number; max: number } | null>(() => {
    try {
      const raw = localStorage.getItem('dermatique_license_devices');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  });
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [activeTab, setActiveTab] = useState<'generator' | 'inventory' | 'records'>('generator');
  const [syncStatus, setSyncStatus] = useState<'online' | 'local' | 'syncing'>('online');

  // Master Catalogs & Data lists
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<{ name: string; action: string }[]>([]);
  const [records, setRecords] = useState<Consultation[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);

  // Toast State
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info'; visible: boolean }>({ message: '', type: 'success', visible: false });

  const [selectedPatientId, setSelectedPatientId] = useState<string>('');
  const [activeConsultationId, setActiveConsultationId] = useState<string>('');

  // ----------------------------------------------------
  // GENERATOR TAB STATE
  // ----------------------------------------------------
  const [patientForm, setPatientForm] = useState({
    id: '',
    firstName: '',
    lastName: '',
    dateOfBirth: '',
    email: '',
    phone: '',
    medicalDiagnosis: '',
    surgicalHistory: '',
    allergiesCosmetics: '[]',
    currentMedications: '[]',
    lifestyleMetrics: '{}',
    skinBiotype: '',
    fitzpatrickScale: 1,
    skinConditions: '[]',
    clinicalNotes: '',
    state: 'Borrador' as ConsultationState,
    allergies: '',
    medicalConditions: '',
    recommendations: '',
    consentAccepted: false,
    beforeImageUrl: '',
    afterImageUrl: '',
    signatureData: ''
  });

  // Autoguardado local de la Ficha en curso (ver useEffects más abajo, cerca de resetPatientForm):
  // protege contra recargas accidentales, cierres del navegador o el especialista cambiando de
  // paciente por error mientras captura un caso nuevo.
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const draftRestoredRef = useRef(false);

  // Consentimiento por firma táctil en escritorio (mouse/trackpad) vs. firma dibujada en dispositivos
  // touch (iPad, tablet): se decide una sola vez por sesión según las capacidades reales del puntero,
  // no por userAgent (iPadOS se anuncia como escritorio desde iOS 13).
  const [isTouchDevice] = useState<boolean>(() => isTouchPrimaryDevice());
  const [signatureValid, setSignatureValid] = useState<boolean>(false);
  const [isSignatureKioskOpen, setIsSignatureKioskOpen] = useState<boolean>(false);

  const [customConditionInput, setCustomConditionInput] = useState('');

  // Steps / Procedure Designer State
  const [currentSteps, setCurrentSteps] = useState<ConsultationStep[]>([]);
  const [stepInput, setStepInput] = useState({
    stepName: 'Otro',
    customStepName: '',
    customProductName: '',
    customBrand: '',
    customActiveIngredients: '',
    customActions: '',
    applicationDescription: '',
    aparatologySettings: '',
    productId: ''
  });
  const [stepSearchQuery, setStepSearchQuery] = useState('');
  const [editingStepIndex, setEditingStepIndex] = useState<number | null>(null);
  const [stepSuggestions, setStepSuggestions] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [homeProtocolName, setHomeProtocolName] = useState<string>('');
  const [isBackupModalOpen, setIsBackupModalOpen] = useState<boolean>(false);
  const [isTrashModalOpen, setIsTrashModalOpen] = useState<boolean>(false);




  // Prescription builder state
  const [prescriptionsList, setPrescriptionsList] = useState<Prescription[]>([]);
  const [presInput, setPresInput] = useState({
    productId: '',
    stepName: 'Otro',
    customStepName: '',
    customProductName: '',
    customBrand: '',
    customActiveIngredients: '',
    customActions: '',
    timeOfDay: 'Dia' as 'Dia' | 'Noche' | 'Dia y Noche',
    dosageInstructions: '',
    applicationFrequency: ''
  });
  const [presSearchQuery, setPresSearchQuery] = useState('');
  const [editingPrescriptionIndex, setEditingPrescriptionIndex] = useState<number | null>(null);
  const [presSuggestions, setPresSuggestions] = useState<Product[]>([]);
  const [selectedPresProduct, setSelectedPresProduct] = useState<Product | null>(null);
  const [activeProtocolTab, setActiveProtocolTab] = useState<'AM' | 'PM' | 'SEMANAL'>('AM');
  const [categoryFilter, setCategoryFilter] = useState<string>('Todos');
  const [showDigitalClientModal, setShowDigitalClientModal] = useState<boolean>(false);

  // Facial interactive map state (Mapa Facial Clínico Interactivo)
  const [activeFacialZones, setActiveFacialZones] = useState<Record<string, boolean>>(
    Object.fromEntries(Object.keys(FACIAL_ZONES).map(k => [k, false]))
  );
  const [hoveredZone, setHoveredZone] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // State PDF choice modal
  const [isPdfModalOpen, setIsPdfModalOpen] = useState(false);

  // Bug Report Modal State
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [reportMessage, setReportMessage] = useState('');
  const [reportSection, setReportSection] = useState('General');
  const [reportImages, setReportImages] = useState<File[]>([]);
  const [isSendingReport, setIsSendingReport] = useState(false);

  const handleSendReport = async () => {
    if (!reportMessage.trim()) return;
    setIsSendingReport(true);
    try {
      await sendManualReport(reportMessage, reportSection, reportImages);
      showToastMsg('Reporte enviado al desarrollador.', 'success');
      setIsReportModalOpen(false);
      setReportMessage('');
      setReportSection('General');
      setReportImages([]);
    } catch (e) {
      showToastMsg('Error al enviar el reporte.', 'error');
    } finally {
      setIsSendingReport(false);
    }
  };

  const handlePasteImage = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const blob = items[i].getAsFile();
        if (blob) {
          const file = new File([blob], `screenshot_${Date.now()}.png`, { type: blob.type });
          setReportImages(prev => [...prev, file]);
          showToastMsg('Imagen pegada del portapapeles.', 'success');
        }
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const filesArr = Array.from(e.target.files);
      setReportImages(prev => [...prev, ...filesArr]);
    }
  };

  const removeReportImage = (index: number) => {
    setReportImages(prev => prev.filter((_, i) => i !== index));
  };

  // APOYO EN CASA Widget states
  const [selectedRoutineTime, setSelectedRoutineTime] = useState<'Dia' | 'Noche'>('Dia');
  const [selectedRoutineTx, setSelectedRoutineTx] = useState<string>('Hidratante');
  const [routineStepSelections, setRoutineStepSelections] = useState<Record<string, string>>({});

  interface CustomRoutine {
    name: string;
    prescriptions: {
      productId?: string;
      timeOfDay: 'Dia' | 'Noche' | 'Dia y Noche';
      dosageInstructions: string;
      applicationFrequency: string;
      stepName?: string;
      customProductName?: string;
      customBrand?: string;
      customActiveIngredients?: string;
      customActions?: string;
      productDetails?: Product;
    }[];
  }

  const [customRoutines, setCustomRoutines] = useState<CustomRoutine[]>(() => {
    try {
      const saved = localStorage.getItem('dermatique_custom_routines');
      return saved ? JSON.parse(saved) : [];
    } catch(e) {
      return [];
    }
  });
  const [showSaveRoutineModal, setShowSaveRoutineModal] = useState(false);
  const [newRoutineName, setNewRoutineName] = useState('');
  const [selectedCustomRoutine, setSelectedCustomRoutine] = useState<CustomRoutine | null>(null);
  const [editableRoutineSteps, setEditableRoutineSteps] = useState<RoutineStepTemplate[]>([]);
  const [editingRoutineStepIdx, setEditingRoutineStepIdx] = useState<number | null>(null);

  useEffect(() => {
    if (selectedRoutineTx && ESTABLISHED_ROUTINES[selectedRoutineTx]) {
      const steps = selectedRoutineTime === 'Dia' ? ESTABLISHED_ROUTINES[selectedRoutineTx].Dia : ESTABLISHED_ROUTINES[selectedRoutineTx].Noche;
      setEditableRoutineSteps(JSON.parse(JSON.stringify(steps)));
      setEditingRoutineStepIdx(null);
    }
  }, [selectedRoutineTx, selectedRoutineTime]);

  // ----------------------------------------------------
  // INVENTORY TAB STATE
  // ----------------------------------------------------
  const [isProductFormOpen, setIsProductFormOpen] = useState(false);
  const [isEditProduct, setIsEditProduct] = useState(false);
  const [productForm, setProductForm] = useState({
    id: '',
    sku: '',
    name: '',
    brandLine: '',
    productType: 'Limpiador / Gel / Leche',
    retailPrice: '',
    isProfessionalUse: 1,
    activeIngredients: '[]',
    physiologicalActions: '[]',
    skinBiotypes: '[]',
    stockQuantity: '',
    costPrice: '',
    reorderPoint: ''
  });
  const [formIngredientInput, setFormIngredientInput] = useState('');
  const [formIngredientAction, setFormIngredientAction] = useState('');
  const [formIngredientsList, setFormIngredientsList] = useState<{ name: string; action: string }[]>([]);
  const [ingredientSuggestions, setIngredientSuggestions] = useState<{ name: string; action: string }[]>([]);
  const [actionSuggestions, setActionSuggestions] = useState<string[]>([]);
  const [showActionDropdown, setShowActionDropdown] = useState<boolean>(false);
  const actionContainerRef = useRef<HTMLDivElement | null>(null);
  const ingredientContainerRef = useRef<HTMLDivElement | null>(null);

  const [brandSuggestions, setBrandSuggestions] = useState<string[]>([]);
  const [showBrandDropdown, setShowBrandDropdown] = useState<boolean>(false);
  const brandContainerRef = useRef<HTMLDivElement | null>(null);
  const presContainerRef = useRef<HTMLDivElement | null>(null);

  const allCapturedProductTypes = useMemo(() => {
    const typeSet = new Set<string>(DEFAULT_PRODUCT_TYPES);
    products.forEach(p => {
      const t = p.productType || inferProductType(p.name, p.brandLine);
      if (t && t.trim()) {
        typeSet.add(t.trim());
      }
    });
    return Array.from(typeSet).sort();
  }, [products]);

  const allCapturedBrands = useMemo(() => {
    const brandSet = new Set<string>();
    products.forEach(p => {
      if (p.brandLine && p.brandLine.trim()) {
        brandSet.add(p.brandLine.trim());
      }
    });
    return Array.from(brandSet).sort();
  }, [products]);

  const allCapturedActions = useMemo(() => {
    const actionSet = new Set<string>();
    
    // 1. Recopilar de la lista maestra de activos
    ingredients.forEach(ing => {
      if (ing.action && ing.action.trim()) {
        actionSet.add(ing.action.trim());
      }
    });

    // 2. Recopilar de todos los productos capturados en la base de datos
    products.forEach(p => {
      const actions = parseStringList(p.physiologicalActions);
      actions.forEach(act => {
        if (act && act.trim()) {
          actionSet.add(act.trim());
        }
      });
    });

    return Array.from(actionSet).sort();
  }, [products, ingredients]);

  const PRESET_SKIN_CONDITIONS = ['Deshidratada', 'Asfixiada/ocluida', 'Sensible', 'Acneica', 'Desvitalizada', 'Poro fino', 'Poro dilatado'];

  // Listas de valores ya capturados en fichas anteriores, para sugerir en campos de texto libre
  // que hoy se re-escriben igual sesión tras sesión (protocolo, alergias, condiciones médicas,
  // "otro" en condición cutánea). Se derivan de `records`, que ya está cargado en memoria — no
  // agregan ninguna consulta nueva a la base de datos.
  const allCapturedProtocols = useMemo(() => {
    const set = new Set<string>();
    records.forEach(r => { if (r.medicalDiagnosis && r.medicalDiagnosis.trim()) set.add(r.medicalDiagnosis.trim()); });
    return Array.from(set).sort();
  }, [records]);

  const allCapturedAllergies = useMemo(() => {
    const set = new Set<string>();
    records.forEach(r => { if (r.allergies && r.allergies.trim()) set.add(r.allergies.trim()); });
    return Array.from(set).sort();
  }, [records]);

  const allCapturedMedicalConditions = useMemo(() => {
    const set = new Set<string>();
    records.forEach(r => { if (r.medicalConditions && r.medicalConditions.trim()) set.add(r.medicalConditions.trim()); });
    return Array.from(set).sort();
  }, [records]);

  // Frases sueltas de recomendaciones ya escritas antes, para insertar en un clic sin tener que
  // redactarlas de nuevo cada vez (se dividen por línea o por punto y coma para obtener frases
  // cortas y reutilizables, no el bloque completo de texto).
  const allCapturedRecommendationPhrases = useMemo(() => {
    const set = new Set<string>();
    records.forEach(r => {
      if (!r.recommendations) return;
      r.recommendations.split(/[\n;]+/).forEach(part => {
        const phrase = part.trim().replace(/^[-•]\s*/, '');
        if (phrase.length >= 8 && phrase.length <= 140) set.add(phrase);
      });
    });
    return Array.from(set).sort();
  }, [records]);

  const allCapturedCustomSkinConditions = useMemo(() => {
    const set = new Set<string>();
    records.forEach(r => {
      try {
        const parsed: string[] = JSON.parse(r.skinConditions || '[]');
        parsed.forEach(c => {
          if (c && c.trim() && !PRESET_SKIN_CONDITIONS.includes(c)) set.add(c.trim());
        });
      } catch (e) {}
    });
    return Array.from(set).sort();
  }, [records]);

  // Catálogo alfabético de activos únicos (ingrediente + acción/efecto clínico), se recalcula
  // automáticamente cada vez que se agregan/editan activos en cualquier producto del catálogo.
  const alphabeticalIngredientsCatalog = useMemo(() => {
    return [...ingredients].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  }, [ingredients]);

  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogBrandFilter, setCatalogBrandFilter] = useState('');
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState('');

  const [activosCatalogSearch, setActivosCatalogSearch] = useState('');
  const [editingCatalogIngredient, setEditingCatalogIngredient] = useState<string | null>(null);
  const [editCatalogNameDraft, setEditCatalogNameDraft] = useState('');
  const [editCatalogActionDraft, setEditCatalogActionDraft] = useState('');

  const filteredIngredientsCatalog = useMemo(() => {
    const q = activosCatalogSearch.toLowerCase().trim();
    if (!q) return alphabeticalIngredientsCatalog;
    return alphabeticalIngredientsCatalog.filter(ing =>
      ing.name.toLowerCase().includes(q) || ing.action.toLowerCase().includes(q)
    );
  }, [alphabeticalIngredientsCatalog, activosCatalogSearch]);

  // Bulk Excel import preview state. `uploadPreviewExcludedIds` marca filas que el usuario no
  // quiere importar (se pre-marcan solas las que ya existen en el catálogo por nombre+marca, para
  // no duplicar al reimportar el mismo archivo, pero el usuario puede reincluirlas con 1 clic).
  const [uploadPreview, setUploadPreview] = useState<Product[]>([]);
  const [uploadPreviewExcludedIds, setUploadPreviewExcludedIds] = useState<Record<string, boolean>>({});
  const [apiBrandSelect, setApiBrandSelect] = useState('');
  const [apiPreview, setApiPreview] = useState<Product[]>([]);

  // ----------------------------------------------------
  // PATIENT FOLDERS & SEARCH/FILTER STATE (TAB 3)
  // ----------------------------------------------------
  const [folderSearchQuery, setFolderSearchQuery] = useState('');
  const [folderBiotypeFilter, setFolderBiotypeFilter] = useState('');
  const [expandedPatientFolders, setExpandedPatientFolders] = useState<Record<string, boolean>>({});

  // ----------------------------------------------------
  // MEMOIZED HIGH-PERFORMANCE DATA SELECTORS
  // ----------------------------------------------------
  const memoizedFilteredProducts = useMemo(() => {
    const searchLower = catalogSearch.toLowerCase().trim();
    if (!searchLower && !catalogBrandFilter && !catalogCategoryFilter) return products;

    return products.filter(p => {
      const matchesBrand = !catalogBrandFilter || p.brandLine === catalogBrandFilter;
      const matchesCategory = !catalogCategoryFilter || (
        p.isProfessionalUse === (catalogCategoryFilter === 'Cabina' ? 1 : catalogCategoryFilter === 'Apoyo Casa' ? 0 : 2)
      );
      if (!matchesBrand || !matchesCategory) return false;
      if (!searchLower) return true;

      return (
        p.name.toLowerCase().includes(searchLower) ||
        p.brandLine.toLowerCase().includes(searchLower) ||
        p.activeIngredients.toLowerCase().includes(searchLower) ||
        (p.sku && p.sku.toLowerCase().includes(searchLower))
      );
    });
  }, [products, catalogSearch, catalogBrandFilter, catalogCategoryFilter]);

  const memoizedGroupedRecords = useMemo(() => {
    return records.filter(r => !r.deletedAt).reduce((acc, curr) => {
      if (!acc[curr.patientId]) {
        acc[curr.patientId] = [];
      }
      acc[curr.patientId].push(curr);
      return acc;
    }, {} as Record<string, Consultation[]>);
  }, [records]);

  const memoizedFilteredPatients = useMemo(() => {
    const query = folderSearchQuery.toLowerCase().trim();
    return patients.filter(pat => !pat.deletedAt).filter(pat => {
      const fullName = `${pat.firstNameEncrypted} ${pat.lastNameEncrypted}`.toLowerCase();
      const phone = (pat.phoneEncrypted || '').toLowerCase();
      const matchesSearch = !query || fullName.includes(query) || phone.includes(query);

      const patConsultations = memoizedGroupedRecords[pat.id] || [];
      const latestConsultation = patConsultations.slice().sort((a, b) => new Date(b.visitDate).getTime() - new Date(a.visitDate).getTime())[0];
      
      const matchesBiotype = !folderBiotypeFilter || (latestConsultation && latestConsultation.skinBiotype === folderBiotypeFilter);

      return matchesSearch && matchesBiotype;
    });
  }, [patients, folderSearchQuery, folderBiotypeFilter, memoizedGroupedRecords]);

  const deletedPatients = useMemo(() => patients.filter(p => p.deletedAt), [patients]);

  const deletedConsultationsWithNames = useMemo(() => {
    return records.filter(r => r.deletedAt).map(c => {
      const pat = patients.find(p => p.id === c.patientId);
      return { ...c, patientName: pat ? `${pat.firstNameEncrypted} ${pat.lastNameEncrypted}` : 'Paciente desconocido' };
    });
  }, [records, patients]);

  const lowStockProducts = useMemo(() => {
    return products.filter(p =>
      p.stockQuantity !== undefined && p.stockQuantity !== null &&
      p.reorderPoint !== undefined && p.reorderPoint !== null &&
      p.stockQuantity <= p.reorderPoint
    );
  }, [products]);

  // ----------------------------------------------------
  // INITIALIZATIONS & BOOTSTRAPPING
  // ----------------------------------------------------
  useEffect(() => {
    // Theme sync
    const savedTheme = localStorage.getItem('theme') || 'light';
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('dark');
      setTheme('dark');
    } else {
      document.documentElement.classList.remove('dark');
      setTheme('light');
    }

    // Check PayPal Return URL parameters or device active license
    const urlParams = new URLSearchParams(window.location.search);
    // "token" es el ID real de la orden que PayPal agrega al regresar (Orders v2 / Hosted Buttons).
    // Los demás (tx, st, PayerID) son señales de que "venimos de PayPal" mantenidas por compatibilidad,
    // pero ya no generan una licencia por sí solas: sin un ID de orden real que el servidor pueda
    // verificar contra PayPal, no se concede acceso.
    const paypalOrderId = urlParams.get('token');
    const activeLicenseToken = localStorage.getItem('dermatique_license_token');

    if (paypalOrderId) {
      (async () => {
        try {
          const resp = await fetch('https://dermatique-license-worker.carlosgbd94.workers.dev/issue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: paypalOrderId, deviceId: getOrCreateDeviceId() })
          });
          const data = await resp.json();
          if (resp.ok && data.licenseKey) {
            localStorage.setItem('dermatique_license_token', data.licenseKey);
            applyLicenseDevices(data.devices);
            setIsLogged(true);
            showToastMsg(`¡Pago confirmado por PayPal! Tu licencia es: ${data.licenseKey} — guárdala, la necesitarás en otros dispositivos.`, 'success');
            bootstrapSystem();
          } else {
            showToastMsg('No se pudo confirmar el pago con PayPal. Si ya pagaste, contacta soporte con tu número de orden.', 'error');
          }
        } catch (err) {
          console.error('Error al verificar el pago de PayPal:', err);
          showToastMsg('Error al verificar el pago con PayPal. Intenta de nuevo o contacta soporte.', 'error');
        } finally {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      })();
    } else if (activeLicenseToken) {
      setIsLogged(true);
      bootstrapSystem();
      revalidateLicenseIfDue(activeLicenseToken);
    }
  }, []);

  // PayPal Hosted Buttons Renderer Effect
  useEffect(() => {
    if (!isLogged) {
      const renderTimer = setTimeout(() => {
        const container = document.getElementById('paypal-container-E8TGNWX7MLLJE');
        if (container && (window as any).paypal?.HostedButtons) {
          container.innerHTML = '';
          try {
            (window as any).paypal.HostedButtons({
              hostedButtonId: "E8TGNWX7MLLJE",
            }).render("#paypal-container-E8TGNWX7MLLJE");
          } catch(e) {
            console.warn('PayPal hosted button initialization:', e);
          }
        }
      }, 300);
      return () => clearTimeout(renderTimer);
    }
  }, [isLogged]);

  // Sync state between network status
  useEffect(() => {
    const handleStatus = () => {
      setSyncStatus(navigator.onLine ? 'online' : 'local');
    };
    window.addEventListener('online', handleStatus);
    window.addEventListener('offline', handleStatus);
    return () => {
      window.removeEventListener('online', handleStatus);
      window.removeEventListener('offline', handleStatus);
    };
  }, []);

  // Listener para cerrar listas desplegables al presionar Escape o hacer clic fuera
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (actionContainerRef.current && !actionContainerRef.current.contains(event.target as Node)) {
        setShowActionDropdown(false);
      }
      if (brandContainerRef.current && !brandContainerRef.current.contains(event.target as Node)) {
        setShowBrandDropdown(false);
      }
      if (ingredientContainerRef.current && !ingredientContainerRef.current.contains(event.target as Node)) {
        setIngredientSuggestions([]);
      }
      if (presContainerRef.current && !presContainerRef.current.contains(event.target as Node)) {
        setPresSuggestions([]);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowActionDropdown(false);
        setShowBrandDropdown(false);
        setIngredientSuggestions([]);
        setPresSuggestions([]);
        setStepSuggestions([]);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  async function bootstrapSystem() {
    setSyncStatus('syncing');
    try {
      await seedTables();
      await restoreLegacyIndexedDBData();

      // Sync remote products to local Dexie on start (without clearing local products)
      if (navigator.onLine) {
        try {
          const tblProducts = getTableName('products');
          const tblPatients = getTableName('patients');
          const tblAnamnesis = getTableName('anamnesis');
          const tblConsultations = getTableName('consultations');
          const tblSteps = getTableName('consultation_steps');
          const tblPrescriptions = getTableName('prescriptions');

          // 1. Sync products
          // Empuja primero los productos locales (upsert, en lotes) antes de halar el remoto: así,
          // si una edición previa (Tipo de Producto/Formato, Precio Público, Costo de Adquisición)
          // se guardó localmente pero el push a Turso falló en su momento (offline o error de red),
          // este reintento la sube antes de que el pull de abajo pueda pisarla con el valor remoto
          // desactualizado.
          const localProdsBeforePull = await db.products.toArray();
          const pushChunkSize = 50;
          for (let i = 0; i < localProdsBeforePull.length; i += pushChunkSize) {
            const chunk = localProdsBeforePull.slice(i, i + pushChunkSize);
            try {
              await saveProducts(chunk);
            } catch (batchErr) {
              console.warn('Fallo al sincronizar lote de productos locales hacia remoto:', batchErr);
            }
          }

          // Pull remoto -> local. Debe traer TODAS las columnas editables del catálogo (antes se
          // omitían product_type, stock_quantity, cost_price y reorder_point, así que cada arranque
          // con conexión borraba esos campos en Dexie porque `put` reemplaza el registro completo).
          //
          // Antes de sobrescribir, se compara updated_at contra el registro local: si el push de una
          // sesión anterior falló silenciosamente (red inestable), el remoto queda con datos viejos y,
          // sin esta comparación, este pull los volvía a pisar sobre la edición local más reciente —
          // exactamente el bug reportado de "los cambios del catálogo no se mantienen entre sesiones".
          const resProds = await executeQuery(`SELECT id, sku, name, brand_line, product_type, active_ingredients, physiological_actions, retail_price, is_professional_use, skin_biotypes, stock_quantity, cost_price, reorder_point, updated_at FROM ${tblProducts}`);
          if (resProds && resProds.rows) {
            for (const r of resProds.rows) {
              const localRecord = await db.products.get(r.id);
              const remoteUpdatedAt = r.updated_at ? new Date(r.updated_at).getTime() : 0;
              const localUpdatedAt = localRecord?.updatedAt ? new Date(localRecord.updatedAt).getTime() : 0;
              if (localRecord && localUpdatedAt > remoteUpdatedAt) {
                continue; // Lo local es más reciente que lo que hay en el remoto: no lo pisamos.
              }
              await db.products.put({
                id: r.id,
                sku: r.sku,
                name: r.name,
                brandLine: r.brand_line,
                productType: r.product_type || undefined,
                activeIngredients: r.active_ingredients,
                physiologicalActions: r.physiological_actions,
                retailPrice: Number(r.retail_price),
                isProfessionalUse: Number(r.is_professional_use),
                skinBiotypes: r.skin_biotypes || '[]',
                stockQuantity: r.stock_quantity !== null && r.stock_quantity !== undefined ? Number(r.stock_quantity) : undefined,
                costPrice: r.cost_price !== null && r.cost_price !== undefined ? Number(r.cost_price) : undefined,
                reorderPoint: r.reorder_point !== null && r.reorder_point !== undefined ? Number(r.reorder_point) : undefined,
                updatedAt: r.updated_at || undefined
              });
            }
          }

          // 2. Sync patients
          const resPatients = await executeQuery(`SELECT id, first_name_encrypted, last_name_encrypted, date_of_birth, email_hashed, phone_encrypted, created_at, updated_at, deleted_at FROM ${tblPatients}`);
          if (resPatients && resPatients.rows) {
            for (const r of resPatients.rows) {
              const decryptedFirstName = await decryptData(r.first_name_encrypted);
              const decryptedLastName = await decryptData(r.last_name_encrypted);
              const decryptedPhone = await decryptData(r.phone_encrypted);
              await db.patients.put({
                id: r.id,
                firstNameEncrypted: decryptedFirstName,
                lastNameEncrypted: decryptedLastName,
                dateOfBirth: r.date_of_birth,
                emailHashed: r.email_hashed,
                phoneEncrypted: decryptedPhone,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                deletedAt: r.deleted_at || undefined
              });
            }
          }

          // 3. Sync anamnesis
          const resAnamnesis = await executeQuery(`SELECT id, patient_id, medical_diagnosis, surgical_history, allergies_cosmetics, current_medications, lifestyle_metrics, updated_at FROM ${tblAnamnesis}`);
          if (resAnamnesis && resAnamnesis.rows) {
            for (const r of resAnamnesis.rows) {
              await db.anamnesis.put({
                id: r.id,
                patientId: r.patient_id,
                medicalDiagnosis: r.medical_diagnosis || undefined,
                surgicalHistory: r.surgical_history || undefined,
                allergiesCosmetics: r.allergies_cosmetics,
                currentMedications: r.current_medications,
                lifestyleMetrics: r.lifestyle_metrics,
                updatedAt: r.updated_at
              });
            }
          }

          // 4. Sync consultations
          const resConsults = await executeQuery(`SELECT id, patient_id, provider_id, visit_date, skin_biotype, fitzpatrick_scale, skin_conditions, medical_diagnosis, clinical_notes, state, recommendations, allergies, medical_conditions, consent_accepted, before_image_url, after_image_url, signature_data, deleted_at FROM ${tblConsultations}`);
          if (resConsults && resConsults.rows) {
            for (const r of resConsults.rows) {
              await db.consultations.put({
                id: r.id,
                patientId: r.patient_id,
                providerId: r.provider_id,
                visitDate: r.visit_date,
                skinBiotype: r.skin_biotype,
                fitzpatrickScale: Number(r.fitzpatrick_scale),
                skinConditions: r.skin_conditions,
                medicalDiagnosis: r.medical_diagnosis || undefined,
                clinicalNotes: r.clinical_notes,
                state: r.state as any,
                recommendations: r.recommendations || undefined,
                allergies: r.allergies || '',
                medicalConditions: r.medical_conditions || '',
                consentAccepted: Number(r.consent_accepted) === 1,
                beforeImageUrl: r.before_image_url || undefined,
                afterImageUrl: r.after_image_url || undefined,
                signatureData: r.signature_data || undefined,
                deletedAt: r.deleted_at || undefined
              });
            }
          }

          // 5. Sync consultation steps
          const resSteps = await executeQuery(`SELECT id, consultation_id, step_order, step_name, product_id, custom_product_name, custom_brand, custom_active_ingredients, custom_actions, application_description, aparatology_settings FROM ${tblSteps}`);
          if (resSteps && resSteps.rows) {
            for (const r of resSteps.rows) {
              await db.consultation_steps.put({
                id: r.id,
                consultationId: r.consultation_id,
                stepOrder: Number(r.step_order),
                stepName: r.step_name,
                productId: r.product_id || undefined,
                customProductName: r.custom_product_name || undefined,
                customBrand: r.custom_brand || undefined,
                customActiveIngredients: r.custom_active_ingredients || undefined,
                customActions: r.custom_actions || undefined,
                applicationDescription: r.application_description || undefined,
                aparatologySettings: r.aparatology_settings || undefined
              });
            }
          }

          // 6. Sync prescriptions
          const resPrescriptions = await executeQuery(`SELECT id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency, step_name, custom_product_name, custom_brand, custom_active_ingredients, custom_actions FROM ${tblPrescriptions}`);
          if (resPrescriptions && resPrescriptions.rows) {
            for (const r of resPrescriptions.rows) {
              await db.prescriptions.put({
                id: r.id,
                consultationId: r.consultation_id,
                productId: r.product_id || undefined,
                timeOfDay: r.time_of_day as any,
                dosageInstructions: r.dosage_instructions,
                applicationFrequency: r.application_frequency,
                stepName: r.step_name || undefined,
                customProductName: r.custom_product_name || undefined,
                customBrand: r.custom_brand || undefined,
                customActiveIngredients: r.custom_active_ingredients || undefined,
                customActions: r.custom_actions || undefined
              });
            }
          }
        } catch (err) {
          console.error("Error syncing remote clinical databases:", err);
        }
      }

      await loadMasterCatalogs();
      setSyncStatus(navigator.onLine ? 'online' : 'local');
    } catch (e) {
      console.error(e);
      setSyncStatus('local');
    }
  }

  async function loadMasterCatalogs() {
    // Load local products
    const pList = await db.products.toArray();
    setProducts(pList);

    // Load ingredients robustly supporting both JSON and text formats
    const resolvedIngredients: { name: string; action: string }[] = [];
    const isBiotypeWord = (str: string) => {
      const s = (str || '').toLowerCase();
      return s.includes('mixta') || s.includes('seborreica') || s.includes('acneica') || s.includes('alípica') || s.includes('eudermica') || s.includes('piel grasa');
    };

    pList.forEach(p => {
      const actives = parseStringList(p.activeIngredients);
      const actions = parseStringList(p.physiologicalActions);

      actives.forEach((act, idx) => {
        const actName = act.trim();
        const actAction = (actions[idx] || actions[0] || '').trim();
        if (!actName) return;

        const existingIdx = resolvedIngredients.findIndex(ri => ri.name.toLowerCase() === actName.toLowerCase());
        if (existingIdx === -1) {
          resolvedIngredients.push({ name: actName, action: actAction || 'Acción dermatológica' });
        } else if (actAction && !isBiotypeWord(actAction)) {
          // Siempre conservar la modificación más reciente del ingrediente/acción clínica
          resolvedIngredients[existingIdx].action = actAction;
        }
      });
    });
    setIngredients(resolvedIngredients);

    // Load sessions / consultations
    const cList = await db.consultations.toArray();
    // Resolve steps and prescriptions
    for (const c of cList) {
      c.steps = await db.consultation_steps.where('consultationId').equals(c.id).toArray();
      c.prescriptions = await db.prescriptions.where('consultationId').equals(c.id).toArray();
    }
    setRecords(cList);

    // Load patients
    const patList = await db.patients.toArray();
    setPatients(patList);
  };

  const showToastMsg = (msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message: msg, type, visible: true });
    setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }));
    }, type === 'info' ? 6000 : 4000);
  };

  // Guarda el cupo de dispositivos que regresa el Worker (2 de 3, etc.) para poder mostrarlo sin
  // tener que volver a validar contra el servidor cada vez que se abre la app.
  const applyLicenseDevices = (devices?: { used: number; max: number } | null) => {
    if (devices && typeof devices.used === 'number' && typeof devices.max === 'number') {
      setLicenseDevices(devices);
      localStorage.setItem('dermatique_license_devices', JSON.stringify(devices));
    }
  };

  // Revalidación periódica y silenciosa: hoy, una vez guardado el token, la app nunca vuelve a
  // preguntarle al servidor si sigue activo, así que una licencia revocada/reembolsada seguiría
  // funcionando para siempre en ese dispositivo. Se revisa como mucho una vez por semana (y solo
  // si hay conexión) para no afectar el uso offline normal. Si el servidor confirma explícitamente
  // que ya no es válida, se cierra sesión; cualquier falla de red se ignora por completo — jamás se
  // cierra sesión solo porque no se pudo confirmar nada.
  const REVALIDATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  const revalidateLicenseIfDue = (token: string) => {
    if (!token || (!!MASTER_LICENSE_KEY && token === MASTER_LICENSE_KEY) || !navigator.onLine) return;

    const lastCheck = Number(localStorage.getItem('dermatique_license_last_check') || 0);
    if (Date.now() - lastCheck < REVALIDATION_INTERVAL_MS) return;

    (async () => {
      try {
        const resp = await fetch('https://dermatique-license-worker.carlosgbd94.workers.dev/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey: token, deviceId: getOrCreateDeviceId() })
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (typeof data.valid !== 'boolean') return;

        localStorage.setItem('dermatique_license_last_check', Date.now().toString());

        if (data.valid) {
          applyLicenseDevices(data.devices);
        } else {
          localStorage.removeItem('dermatique_license_token');
          localStorage.removeItem('dermatique_license_devices');
          setLicenseDevices(null);
          setIsLogged(false);
          showToastMsg('Tu licencia ya no está activa (revocada, reembolsada o vencida). Vuelve a activarla para continuar.', 'error');
        }
      } catch (err) {
        console.warn('No se pudo revalidar la licencia en este arranque (se reintentará después):', err);
      }
    })();
  };

  // ----------------------------------------------------
  // LICENSE ACTIVATION (CLOUDFLARE WORKERS / LOCAL HMAC)
  // ----------------------------------------------------
  const handleLicenseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);

    const cleanKey = licenseKeyInput.trim().toUpperCase();
    let deviceLimitReached = false;

    try {
      // 1. Validar a través del Endpoint de Cloudflare Workers si hay conexión
      if (navigator.onLine) {
        try {
          const cfWorkerUrl = 'https://dermatique-license-worker.carlosgbd94.workers.dev/validate';
          const response = await fetch(cfWorkerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey: cleanKey, deviceId: getOrCreateDeviceId() })
          });

          if (response.ok) {
            const data = await response.json();
            if (data.valid) {
              localStorage.setItem('dermatique_license_token', cleanKey);
              applyLicenseDevices(data.devices);
              setIsLogged(true);
              const quotaMsg = data.devices ? ` (${data.devices.used} de ${data.devices.max} dispositivos activados)` : '';
              showToastMsg(`Licencia activada con éxito en este dispositivo.${quotaMsg}`, 'success');
              bootstrapSystem();
              return;
            }
            if (data.reason === 'device_limit') {
              deviceLimitReached = true;
            }
          }
        } catch (apiErr) {
          console.warn('Cloudflare Worker fallback to cryptographic offline validation.', apiErr);
        }
      }

      if (deviceLimitReached) {
        setLoginError('Esta licencia ya se activó en el máximo de 3 dispositivos permitidos. Contacta soporte si necesitas liberar un dispositivo.');
        return;
      }

      // 2. Respaldo offline: solo la clave maestra exacta, sin aceptar cualquier texto con forma
      // "DERM-XXXX-XXXX-XXXX" (ese patrón abierto no validaba nada realmente, aceptaba cualquier
      // clave inventada con ese formato).
      const isMasterKey = !!MASTER_LICENSE_KEY && cleanKey === MASTER_LICENSE_KEY;

      if (isMasterKey) {
        localStorage.setItem('dermatique_license_token', cleanKey);
        setIsLogged(true);
        showToastMsg('Licencia Profesional Validada.', 'success');
        bootstrapSystem();
      } else {
        setLoginError('Licencia no válida o expirada. Verifica la clave o adquiere una en PayPal.');
      }
    } catch (err) {
      console.error(err);
      setLoginError('Error al validar la licencia de dispositivo.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('dermatique_license_token');
    localStorage.removeItem('dermatique_license_devices');
    localStorage.removeItem('dermatique_license_last_check');
    setIsLogged(false);
    window.location.reload();
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  };

  // ----------------------------------------------------
  // PROCEDURAL STATE MACHINE DESIGNER
  // ----------------------------------------------------
  const updateState = (newState: ConsultationState) => {
    if (validateStateTransition(patientForm.state, newState)) {
      setPatientForm(prev => ({ ...prev, state: newState }));
      showToastMsg(`Estado cambiado a ${newState}`, 'success');
    } else {
      showToastMsg(`Transición de ${patientForm.state} a ${newState} no permitida.`, 'error');
    }
  };

  // -----------------------------------------  // Ref to target clinical notes textarea directly for autofocus
  const notesTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // MAPA FACIAL CLÍNICO INTERACTIVO (SVG sobre la foto de referencia)
  // ----------------------------------------------------
  const [isBackdropLoaded, setIsBackdropLoaded] = useState(false);

  // Toggles a facial zone on/off, syncing the clinical notes bullet. Shared by clicks on the SVG
  // shapes and by the always-visible legend list next to the map (so zone names stay selectable
  // even where a tiny shape is hard to tap precisely, e.g. on mobile).
  const toggleFacialZone = (clickedKey: string, clickedLabel: string) => {
    setActiveFacialZones(prev => {
      const nextState = { ...prev, [clickedKey]: !prev[clickedKey] };
      const isActivating = nextState[clickedKey];

      setPatientForm(prevForm => {
        let updatedNotes = prevForm.clinicalNotes;
        const zoneBullet = `- [Zona: ${clickedLabel}] `;

        if (isActivating) {
          // Append bullet if it doesn't exist yet
          if (!updatedNotes.includes(zoneBullet)) {
            updatedNotes = updatedNotes.trim();
            if (updatedNotes.length > 0) {
              updatedNotes += `\n${zoneBullet}`;
            } else {
              updatedNotes = zoneBullet;
            }
          }
        } else {
          // Remove bullet line if de-selecting
          updatedNotes = updatedNotes
            .split('\n')
            .filter(line => !line.startsWith(zoneBullet))
            .join('\n');
        }

        // Dynamic DOM autofocus with cursor at end of the notes
        setTimeout(() => {
          if (notesTextareaRef.current) {
            notesTextareaRef.current.focus();
            const textLen = notesTextareaRef.current.value.length;
            notesTextareaRef.current.setSelectionRange(textLen, textLen);
          }
        }, 50);

        return {
          ...prevForm,
          clinicalNotes: updatedNotes
        };
      });

      return nextState;
    });
    showToastMsg(`Zona ${clickedLabel} seleccionada`, 'success');
  };

  // ----------------------------------------------------
  // PROCEDURAL STEPS BUILDER & COMPATIBILITY
  // ----------------------------------------------------
  const handleProductSearch = (val: string) => {
    setStepSearchQuery(val);
    if (!val.trim()) {
      setStepSuggestions([]);
      return;
    }

    const fuse = new Fuse(products, {
      keys: ['name', 'brandLine', 'activeIngredients'],
      threshold: 0.4
    });

    const results = fuse.search(val).map(r => r.item);
    setStepSuggestions(sortByBiotypeMatch(results, patientForm.skinBiotype).slice(0, 6));
  };

  const selectSearchProduct = (p: Product) => {
    setSelectedProduct(p);
    setStepSearchQuery(p.name);
    setStepSuggestions([]);

    let actives = '';
    let actions = '';
    try {
      actives = JSON.parse(p.activeIngredients).join(', ');
      actions = JSON.parse(p.physiologicalActions).join(', ');
    } catch(e) {
      actives = p.activeIngredients;
      actions = p.physiologicalActions;
    }

    setStepInput(prev => ({
      ...prev,
      customProductName: p.name,
      customBrand: p.brandLine,
      customActiveIngredients: actives,
      customActions: actions,
      productId: p.id
    }));
  };

  const toggleAparatology = (option: string) => {
    let current: string[] = [];
    try {
      current = JSON.parse(stepInput.aparatologySettings || '[]');
    } catch(e) {
      current = stepInput.aparatologySettings ? stepInput.aparatologySettings.split(', ') : [];
    }

    if (current.includes(option)) {
      current = current.filter(o => o !== option);
    } else {
      current.push(option);
    }

    setStepInput(prev => ({
      ...prev,
      aparatologySettings: JSON.stringify(current)
    }));
  };

  const handleAddStep = () => {
    if (editingStepIndex !== null) {
      setCurrentSteps(prev => {
        const nextSteps = [...prev];
        const oldStep = nextSteps[editingStepIndex];
        nextSteps[editingStepIndex] = {
          ...oldStep,
          stepName: stepInput.stepName === 'Otro' ? (stepInput.customStepName || 'Otro') : stepInput.stepName,
          productId: stepInput.productId || undefined,
          customProductName: stepInput.customProductName.trim() || 'Sin producto',
          customBrand: stepInput.customBrand.trim() || 'N/A',
          customActiveIngredients: stepInput.customActiveIngredients,
          customActions: stepInput.customActions,
          applicationDescription: stepInput.applicationDescription,
          aparatologySettings: stepInput.aparatologySettings || undefined,
          productDetails: selectedProduct || undefined
        };
        return nextSteps;
      });
      setEditingStepIndex(null);
      showToastMsg('Paso actualizado en el protocolo.', 'success');
    } else {
      const newStep: ConsultationStep = {
        id: Math.random().toString(36).substring(2, 9).toUpperCase(),
        consultationId: patientForm.id || 'TEMP',
        stepOrder: currentSteps.length + 1,
        stepName: stepInput.stepName === 'Otro' ? (stepInput.customStepName || 'Otro') : stepInput.stepName,
        productId: stepInput.productId || undefined,
        customProductName: stepInput.customProductName.trim() || 'Sin producto',
        customBrand: stepInput.customBrand.trim() || 'N/A',
        customActiveIngredients: stepInput.customActiveIngredients,
        customActions: stepInput.customActions,
        applicationDescription: stepInput.applicationDescription,
        aparatologySettings: stepInput.aparatologySettings || undefined,
        productDetails: selectedProduct || undefined
      };

      setCurrentSteps(prev => [...prev, newStep]);
      showToastMsg('Paso agregado al protocolo.', 'success');
    }
    
    // Clear step inputs
    setStepInput({
      stepName: 'Otro',
      customStepName: '',
      customProductName: '',
      customBrand: '',
      customActiveIngredients: '',
      customActions: '',
      applicationDescription: '',
      aparatologySettings: '',
      productId: ''
    });
    setStepSearchQuery('');
    setSelectedProduct(null);
  };

  const cancelEditStep = () => {
    setEditingStepIndex(null);
    setStepInput({
      stepName: 'Otro',
      customStepName: '',
      customProductName: '',
      customBrand: '',
      customActiveIngredients: '',
      customActions: '',
      applicationDescription: '',
      aparatologySettings: '',
      productId: ''
    });
    setStepSearchQuery('');
    setSelectedProduct(null);
  };

  const removeStep = (idx: number) => {
    const nextSteps = [...currentSteps];
    nextSteps.splice(idx, 1);
    // Re-order remaining steps
    const reordered = nextSteps.map((s, i) => ({ ...s, stepOrder: i + 1 }));
    setCurrentSteps(reordered);
    if (editingStepIndex === idx) {
      setEditingStepIndex(null);
    } else if (editingStepIndex !== null && editingStepIndex > idx) {
      setEditingStepIndex(editingStepIndex - 1);
    }
  };

  const editStep = (idx: number) => {
    const step = currentSteps[idx];
    
    if (step.productId && step.productDetails) {
      setSelectedProduct(step.productDetails);
    } else if (step.productId) {
      const prod = products.find(p => p.id === step.productId);
      if (prod) setSelectedProduct(prod);
    } else {
      setSelectedProduct(null);
    }

    setStepInput({
      stepName: ['Limpieza', 'Shampoo', 'Exfoliación', 'Tonificación', 'Armonizador', 'Principio Activo', 'Mascarilla', 'Crema de Sellado', 'Protección Solar', 'Apoyo en Casa'].includes(step.stepName) ? step.stepName : 'Otro',
      customStepName: ['Limpieza', 'Shampoo', 'Exfoliación', 'Tonificación', 'Armonizador', 'Principio Activo', 'Mascarilla', 'Crema de Sellado', 'Protección Solar', 'Apoyo en Casa'].includes(step.stepName) ? '' : step.stepName,
      customProductName: step.customProductName || '',
      customBrand: step.customBrand || '',
      customActiveIngredients: step.customActiveIngredients || '',
      customActions: step.customActions || '',
      applicationDescription: step.applicationDescription || '',
      aparatologySettings: step.aparatologySettings || '[]',
      productId: step.productId || ''
    });
    setEditingStepIndex(idx);
    showToastMsg('Paso cargado en el formulario para edición.', 'success');
  };

  const moveStepUp = (index: number) => {
    if (index === 0) return;
    const nextSteps = [...currentSteps];
    const temp = nextSteps[index];
    nextSteps[index] = nextSteps[index - 1];
    nextSteps[index - 1] = temp;
    const reordered = nextSteps.map((s, i) => ({ ...s, stepOrder: i + 1 }));
    setCurrentSteps(reordered);
  };

  const moveStepDown = (index: number) => {
    if (index === currentSteps.length - 1) return;
    const nextSteps = [...currentSteps];
    const temp = nextSteps[index];
    nextSteps[index] = nextSteps[index + 1];
    nextSteps[index + 1] = temp;
    const reordered = nextSteps.map((s, i) => ({ ...s, stepOrder: i + 1 }));
    setCurrentSteps(reordered);
  };

  // ----------------------------------------------------
  // RECIPE BUILDER (Home Support Protocols Designer)
  // ----------------------------------------------------
  const handlePresProductSearch = (val: string) => {
    setPresSearchQuery(val);
    if (!val.trim()) {
      setPresSuggestions([]);
      return;
    }
    const matches = products.filter(p => p.name.toLowerCase().includes(val.toLowerCase()) || p.brandLine.toLowerCase().includes(val.toLowerCase()));
    setPresSuggestions(sortByBiotypeMatch(matches, patientForm.skinBiotype).slice(0, 5));
  };

  const selectPresSearchProduct = (p: Product) => {
    setSelectedPresProduct(p);
    setPresSearchQuery('');
    setPresSuggestions([]);
    
    let actives = '';
    try {
      actives = JSON.parse(p.activeIngredients).join(', ');
    } catch(e) {
      actives = p.activeIngredients;
    }

    let actions = '';
    try {
      actions = JSON.parse(p.physiologicalActions).join(', ');
    } catch(e) {
      actions = p.physiologicalActions;
    }

    // Inferir fase técnica basada en el orden de capas cosmetológicas
    const order = getLayerOrder(p.name + ' ' + p.brandLine);
    let inferredStep = 'Otro';
    if (order === 1) inferredStep = 'Limpieza / Higiene';
    else if (order === 2) inferredStep = 'Tonificación / Loción';
    else if (order === 3) inferredStep = 'Contorno de Ojos';
    else if (order === 4) inferredStep = 'Suero / Activo Concentrado';
    else if (order === 5) inferredStep = 'Crema / Emulsión / Hidratante';
    else if (order === 6) inferredStep = 'Protección Solar';
    else if (order === 7) inferredStep = 'Mascarilla Semanal';
    else if (order === 8) inferredStep = 'Exfoliación Semanal';

    setPresInput(prev => ({
      ...prev,
      productId: p.id,
      stepName: inferredStep !== 'Otro' ? inferredStep : prev.stepName,
      customProductName: p.name,
      customBrand: p.brandLine,
      customActiveIngredients: actives,
      customActions: actions,
      dosageInstructions: prev.dosageInstructions || 'Aplicar según protocolo.',
      applicationFrequency: prev.applicationFrequency || 'Diario'
    }));
  };

  const handleAutoGenerateHomeRoutine = () => {
    let condsStr = '';
    try {
      const parsed = JSON.parse(patientForm.skinConditions || '[]');
      condsStr = Array.isArray(parsed) ? parsed.join(', ') : patientForm.skinConditions;
    } catch (e) {
      condsStr = patientForm.skinConditions || '';
    }

    const currentBio = patientForm.skinBiotype || 'Piel Eudérmica';
    const suggested = generateSuggestedHomeRoutine(currentBio, condsStr, products);
    if (suggested.length === 0) {
      showToastMsg('No se pudieron generar sugerencias para el biotipo actual.', 'error');
      return;
    }

    const newList: Prescription[] = suggested.map(s => ({
      id: Math.random().toString(36).substring(2, 9).toUpperCase(),
      consultationId: patientForm.id || 'TEMP',
      productId: s.productId,
      timeOfDay: s.timeOfDay || 'Dia',
      dosageInstructions: s.dosageInstructions || '',
      applicationFrequency: s.applicationFrequency || '',
      stepName: s.stepName,
      customProductName: s.customProductName,
      customBrand: s.customBrand,
      customActiveIngredients: s.customActiveIngredients,
      customActions: s.customActions,
      productDetails: s.productDetails
    }));

    setPrescriptionsList(newList);
    showToastMsg(`⚡ Rutina sugerida por biotipo (${currentBio}) cargada.`, 'success');
  };

  const handleAddPrescription = () => {
    const finalStepName = presInput.stepName === 'Otro' ? (presInput.customStepName || 'Otro') : presInput.stepName;
    const finalProductName = presInput.customProductName.trim() || 'Sin producto';
    const finalBrand = presInput.customBrand.trim() || 'N/A';

    if (editingPrescriptionIndex !== null) {
      setPrescriptionsList(prev => {
        const nextList = [...prev];
        nextList[editingPrescriptionIndex] = {
          ...nextList[editingPrescriptionIndex],
          stepName: finalStepName,
          productId: presInput.productId || undefined,
          customProductName: finalProductName,
          customBrand: finalBrand,
          customActiveIngredients: presInput.customActiveIngredients,
          customActions: presInput.customActions,
          timeOfDay: presInput.timeOfDay,
          dosageInstructions: presInput.dosageInstructions,
          applicationFrequency: presInput.applicationFrequency,
          productDetails: selectedPresProduct || undefined
        };
        return nextList;
      });
      setEditingPrescriptionIndex(null);
      showToastMsg('Recomendación de apoyo actualizada.', 'success');
    } else {
      const newPres: Prescription = {
        id: Math.random().toString(36).substring(2, 9).toUpperCase(),
        consultationId: patientForm.id || 'TEMP',
        productId: presInput.productId || undefined,
        timeOfDay: presInput.timeOfDay,
        dosageInstructions: presInput.dosageInstructions,
        applicationFrequency: presInput.applicationFrequency,
        stepName: finalStepName,
        customProductName: finalProductName,
        customBrand: finalBrand,
        customActiveIngredients: presInput.customActiveIngredients,
        customActions: presInput.customActions,
        productDetails: selectedPresProduct || undefined
      };
      setPrescriptionsList(prev => [...prev, newPres]);
      showToastMsg('Recomendación de apoyo agregada.', 'success');
    }

    // Reset input
    setPresInput({
      productId: '',
      stepName: 'Otro',
      customStepName: '',
      customProductName: '',
      customBrand: '',
      customActiveIngredients: '',
      customActions: '',
      timeOfDay: 'Dia',
      dosageInstructions: '',
      applicationFrequency: ''
    });
    setSelectedPresProduct(null);
    setPresSearchQuery('');
  };

  const removePrescription = (idx: number) => {
    const list = [...prescriptionsList];
    list.splice(idx, 1);
    setPrescriptionsList(list);
  };

  const editPrescription = (idx: number) => {
    const p = prescriptionsList[idx];
    setEditingPrescriptionIndex(idx);
    
    const knownFases = ['Limpieza', 'Tonificación', 'Suero / Activo', 'Crema de Día', 'Crema de Noche', 'Contorno de Ojos', 'Protección Solar', 'Mascarilla', 'Exfoliación'];
    const isKnown = knownFases.includes(p.stepName || '');
    
    setPresInput({
      productId: p.productId || '',
      stepName: isKnown ? (p.stepName || 'Otro') : 'Otro',
      customStepName: isKnown ? '' : (p.stepName || ''),
      customProductName: p.customProductName || '',
      customBrand: p.customBrand || '',
      customActiveIngredients: p.customActiveIngredients || '',
      customActions: p.customActions || '',
      timeOfDay: p.timeOfDay,
      dosageInstructions: p.dosageInstructions,
      applicationFrequency: p.applicationFrequency
    });
    setSelectedPresProduct(p.productDetails || null);
    setPresSearchQuery('');
  };

  const cancelEditPrescription = () => {
    setEditingPrescriptionIndex(null);
    setPresInput({
      productId: '',
      stepName: 'Otro',
      customStepName: '',
      customProductName: '',
      customBrand: '',
      customActiveIngredients: '',
      customActions: '',
      timeOfDay: 'Dia',
      dosageInstructions: '',
      applicationFrequency: ''
    });
    setSelectedPresProduct(null);
    setPresSearchQuery('');
  };

  const movePrescriptionUp = (idx: number) => {
    if (idx === 0) return;
    setPrescriptionsList(prev => {
      const next = [...prev];
      const temp = next[idx];
      next[idx] = next[idx - 1];
      next[idx - 1] = temp;
      return next;
    });
  };

  const movePrescriptionDown = (idx: number) => {
    if (idx === prescriptionsList.length - 1) return;
    setPrescriptionsList(prev => {
      const next = [...prev];
      const temp = next[idx];
      next[idx] = next[idx + 1];
      next[idx + 1] = temp;
      return next;
    });
  };

  // ----------------------------------------------------
  // SAVE ENTIRE CLINICAL SHEET (ACID Transaction)
  // ----------------------------------------------------
  const handleSaveConsultation = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!patientForm.firstName || !patientForm.lastName || !patientForm.phone) {
      showToastMsg('Nombre, apellido y teléfono del paciente son obligatorios.', 'error');
      return;
    }

    try {
      const patientId = selectedPatientId || `P-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
      const emailH = await sha256(patientForm.email || `${patientForm.firstName}.${patientForm.lastName}.${patientId}@clinical.local`);

      const consultationId = activeConsultationId || `C-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

      // Register anamnesis on remote if online (patient itself is saved via savePatient below)
      if (navigator.onLine) {
        try {
          const tblAnamnesis = getTableName('anamnesis');
          await executeQuery(
            `INSERT INTO ${tblAnamnesis} (id, patient_id, medical_diagnosis, surgical_history, allergies_cosmetics, current_medications, lifestyle_metrics, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               medical_diagnosis = excluded.medical_diagnosis,
               surgical_history = excluded.surgical_history,
               allergies_cosmetics = excluded.allergies_cosmetics,
               current_medications = excluded.current_medications,
               lifestyle_metrics = excluded.lifestyle_metrics,
               updated_at = CURRENT_TIMESTAMP`,
            [`A-${patientId}`, patientId, patientForm.medicalDiagnosis || null, patientForm.surgicalHistory || null, patientForm.allergiesCosmetics, patientForm.currentMedications, patientForm.lifestyleMetrics]
          );
        } catch (remoteErr) {
          console.warn("Fallo al registrar anamnesis en Turso, se continuará localmente:", remoteErr);
        }
      }

      // Local Dexie Save for patient (savePatient también intenta el guardado remoto internamente)
      const localPatient: Patient = {
        id: patientId,
        firstNameEncrypted: patientForm.firstName, // Store decrypted locally for ease of UI display
        lastNameEncrypted: patientForm.lastName,
        dateOfBirth: patientForm.dateOfBirth || '2000-01-01',
        emailHashed: emailH,
        phoneEncrypted: patientForm.phone,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await savePatient(localPatient);

      const localAnamnesis: Anamnesis = {
        id: `A-${patientId}`,
        patientId,
        medicalDiagnosis: patientForm.medicalDiagnosis || undefined,
        surgicalHistory: patientForm.surgicalHistory || undefined,
        allergiesCosmetics: patientForm.allergiesCosmetics,
        currentMedications: patientForm.currentMedications,
        lifestyleMetrics: patientForm.lifestyleMetrics,
        updatedAt: new Date().toISOString()
      };
      await db.anamnesis.put(localAnamnesis);

      // Create consultation entry
      const finalConsultation: Consultation = {
        id: consultationId,
        patientId,
        providerId: 'clinica_dermatique',
        visitDate: new Date().toISOString(),
        skinBiotype: patientForm.skinBiotype || 'Mixta',
        fitzpatrickScale: patientForm.fitzpatrickScale,
        skinConditions: patientForm.skinConditions,
        medicalDiagnosis: patientForm.medicalDiagnosis || undefined,
        clinicalNotes: patientForm.clinicalNotes,
        state: patientForm.state,
        allergies: patientForm.allergies || '',
        medicalConditions: patientForm.medicalConditions || '',
        recommendations: patientForm.recommendations || '',
        consentAccepted: isTouchDevice ? signatureValid : (patientForm.consentAccepted || false),
        beforeImageUrl: patientForm.beforeImageUrl || undefined,
        afterImageUrl: patientForm.afterImageUrl || undefined,
        signatureData: isTouchDevice ? (patientForm.signatureData || undefined) : undefined
      };

      const finalSteps = currentSteps.map(s => ({ ...s, consultationId }));
      const finalPrescriptions = prescriptionsList.map(p => ({ ...p, consultationId }));

      // Trigger ACID atomicity remote & local
      try {
        await saveConsultationTransaction(finalConsultation, finalSteps, finalPrescriptions);
        showToastMsg('Expediente clínico guardado y sincronizado.', 'success');
      } catch (remoteErr) {
        console.warn('Fallo al sincronizar consulta con Turso, guardado local completado:', remoteErr);
        showToastMsg('Expediente guardado en local (Modo Offline). Se sincronizará al conectar.', 'info');
      }

      loadMasterCatalogs();
      resetPatientForm({ skipConfirm: true });
    } catch(err) {
      console.error(err);
      showToastMsg('Fallo en la transacción de guardado clínico.', 'error');
    }
  };

  const toggleSkinCondition = (condition: string) => {
    let current: string[] = [];
    try {
      current = JSON.parse(patientForm.skinConditions || '[]');
    } catch(e) {}

    if (current.includes(condition)) {
      current = current.filter(c => c !== condition);
    } else {
      current.push(condition);
    }

    setPatientForm(prev => ({
      ...prev,
      skinConditions: JSON.stringify(current)
    }));
  };

  const handleCustomConditionChange = (value: string) => {
    setCustomConditionInput(value);
    let current: string[] = [];
    try {
      current = JSON.parse(patientForm.skinConditions || '[]');
    } catch(e) {}
    const predefined = ['Deshidratada', 'Asfixiada/ocluida', 'Sensible', 'Acneica', 'Desvitalizada', 'Poro fino', 'Poro dilatado'];
    current = current.filter(c => predefined.includes(c));
    if (value.trim()) {
      current.push(value.trim());
    }
    setPatientForm(prev => ({
      ...prev,
      skinConditions: JSON.stringify(current)
    }));
  };

  const toggleOtroCondition = () => {
    let current: string[] = [];
    try {
      current = JSON.parse(patientForm.skinConditions || '[]');
    } catch(e) {}
    const predefined = ['Deshidratada', 'Asfixiada/ocluida', 'Sensible', 'Acneica', 'Desvitalizada', 'Poro fino', 'Poro dilatado'];
    const hasCustom = current.some(c => !predefined.includes(c));
    if (hasCustom) {
      current = current.filter(c => predefined.includes(c));
    } else {
      const val = customConditionInput.trim() || 'Otro';
      current.push(val);
      if (!customConditionInput) {
        setCustomConditionInput('Otro');
      }
    }
    setPatientForm(prev => ({
      ...prev,
      skinConditions: JSON.stringify(current)
    }));
  };

  const handleSelectPatient = async (patientId: string) => {
    if (!patientId) {
      // resetPatientForm ya confirma (si hace falta) antes de limpiar; si el especialista cancela,
      // el <select> controlado permanece en su valor actual sin perder lo capturado.
      resetPatientForm();
      return;
    }

    const pat = patients.find(p => p.id === patientId);
    if (!pat) return;

    // Cambiar de paciente a medio capturar un caso nuevo (o edición no guardada) descarta esos
    // datos; se confirma antes de pisarlos con el historial del paciente recién seleccionado.
    if (hasMeaningfulDraftContent()) {
      const confirmed = window.confirm('Hay información sin guardar en la ficha actual. Si seleccionas otro paciente, se perderá. ¿Deseas continuar?');
      if (!confirmed) return;
    }
    localStorage.removeItem(FICHA_DRAFT_KEY);
    setDraftSavedAt(null);

    setSelectedPatientId(patientId);
    setActiveConsultationId('');

    const anam = await db.anamnesis.where('patientId').equals(patientId).first();

    const patientConsultations = records
      .filter(r => r.patientId === patientId)
      .sort((a, b) => new Date(b.visitDate).getTime() - new Date(a.visitDate).getTime());

    const latestConsultation = patientConsultations[0];

    setPatientForm(prev => ({
      ...prev,
      firstName: pat.firstNameEncrypted || '',
      lastName: pat.lastNameEncrypted || '',
      dateOfBirth: pat.dateOfBirth || '',
      phone: pat.phoneEncrypted || '',
      email: '',
      skinBiotype: latestConsultation ? latestConsultation.skinBiotype : '',
      fitzpatrickScale: latestConsultation ? latestConsultation.fitzpatrickScale : 1,
      skinConditions: latestConsultation ? latestConsultation.skinConditions : '[]',
      medicalDiagnosis: latestConsultation ? latestConsultation.medicalDiagnosis : '',
      allergies: latestConsultation ? (latestConsultation.allergies || '') : '',
      medicalConditions: latestConsultation ? (latestConsultation.medicalConditions || '') : '',
      clinicalNotes: '',
      state: 'Borrador',
      surgicalHistory: anam ? (anam.surgicalHistory || '') : '',
      allergiesCosmetics: anam ? (anam.allergiesCosmetics || '[]') : '[]',
      currentMedications: anam ? (anam.currentMedications || '[]') : '[]',
      lifestyleMetrics: anam ? (anam.lifestyleMetrics || '{}') : '{}',
      recommendations: latestConsultation ? (latestConsultation.recommendations || '') : '',
    }));

    setCurrentSteps([]);
    setPrescriptionsList([]);
    if (latestConsultation) {
      showToastMsg(`Paciente ${pat.firstNameEncrypted} seleccionado. Datos clínicos cargados, protocolo de tratamiento iniciado en blanco para nueva visita.`, 'success');
    } else {
      showToastMsg(`Paciente ${pat.firstNameEncrypted} seleccionado. Sin consultas previas.`, 'success');
    }
  };

  const handleLoadPreviousConsultationBaseline = async (c: Consultation) => {
    const steps = await db.consultation_steps.where('consultationId').equals(c.id).toArray();
    const prescriptions = await db.prescriptions.where('consultationId').equals(c.id).toArray();
    
    let condList: string[] = [];
    try {
      condList = JSON.parse(c.skinConditions || '[]');
    } catch(e) {}
    const customCond = condList.find(cond => !['Deshidratada', 'Asfixiada/ocluida', 'Sensible', 'Acneica', 'Desvitalizada', 'Poro fino', 'Poro dilatado'].includes(cond));
    setCustomConditionInput(customCond || '');

    setPatientForm(prev => ({
      ...prev,
      skinBiotype: c.skinBiotype,
      fitzpatrickScale: c.fitzpatrickScale,
      skinConditions: c.skinConditions || '[]',
      medicalDiagnosis: c.medicalDiagnosis || '',
      clinicalNotes: '',
      allergies: c.allergies || '',
      medicalConditions: c.medicalConditions || '',
      recommendations: c.recommendations || ''
    }));

    const freshSteps = steps.map(s => ({
      ...s,
      id: `STEP-${Math.floor(Math.random() * 1000000)}`,
      consultationId: ''
    }));

    const freshPrescriptions = prescriptions.map(p => ({
      ...p,
      id: `PRES-${Math.floor(Math.random() * 1000000)}`,
      consultationId: ''
    }));

    setCurrentSteps(freshSteps.sort((a, b) => a.stepOrder - b.stepOrder));
    setPrescriptionsList(freshPrescriptions);
    showToastMsg(`Se cargaron los datos de la sesión del ${new Date(c.visitDate).toLocaleDateString()} como base.`, 'success');
  };

  // Borrado suave: mueve a la Papelera en vez de destruir el registro de inmediato.
  const handleDeleteConsultation = async (consultationId: string, patientId: string) => {
    if (!window.confirm('¿Enviar esta visita a la papelera? Podrás restaurarla después desde ahí.')) {
      return;
    }
    try {
      const nowIso = new Date().toISOString();
      const consultation = records.find(r => r.id === consultationId);
      if (consultation) {
        await db.consultations.put({ ...consultation, deletedAt: nowIso });
      }

      try {
        const tblConsultations = getTableName('consultations');
        await executeQuery(`UPDATE ${tblConsultations} SET deleted_at = ? WHERE id = ?`, [nowIso, consultationId]);
      } catch (err) {
        console.warn('Fallo al enviar la visita a la papelera en Turso, se reintentará en la sincronización:', err);
      }

      showToastMsg('Visita movida a la papelera.', 'success');

      if (activeConsultationId === consultationId) {
        setActiveConsultationId('');
        resetPatientForm({ skipConfirm: true });
      }

      await loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al mover la visita a la papelera.', 'error');
    }
  };

  const handleDeletePatient = async (patientId: string) => {
    if (!window.confirm('¿Enviar este paciente a la papelera? Su expediente y consultas no se borran, solo se ocultan, y podrás restaurarlo después.')) {
      return;
    }
    try {
      const nowIso = new Date().toISOString();
      const patient = patients.find(p => p.id === patientId);
      if (patient) {
        await db.patients.put({ ...patient, deletedAt: nowIso });
      }

      try {
        const tblPatients = getTableName('patients');
        await executeQuery(`UPDATE ${tblPatients} SET deleted_at = ? WHERE id = ?`, [nowIso, patientId]);
      } catch (err) {
        console.warn('Fallo al enviar el paciente a la papelera en Turso, se reintentará en la sincronización:', err);
      }

      showToastMsg('Paciente movido a la papelera.', 'success');

      if (selectedPatientId === patientId) {
        setSelectedPatientId('');
        setActiveConsultationId('');
        resetPatientForm({ skipConfirm: true });
      }
      await loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al mover el paciente a la papelera.', 'error');
    }
  };

  const handleRestoreConsultation = async (consultationId: string) => {
    try {
      const consultation = await db.consultations.get(consultationId);
      if (consultation) {
        const { deletedAt, ...rest } = consultation;
        await db.consultations.put(rest as Consultation);
      }
      try {
        const tblConsultations = getTableName('consultations');
        await executeQuery(`UPDATE ${tblConsultations} SET deleted_at = NULL WHERE id = ?`, [consultationId]);
      } catch (err) {
        console.warn('Fallo al restaurar la visita en Turso:', err);
      }
      showToastMsg('Visita restaurada.', 'success');
      await loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al restaurar la visita.', 'error');
    }
  };

  const handleRestorePatient = async (patientId: string) => {
    try {
      const patient = await db.patients.get(patientId);
      if (patient) {
        const { deletedAt, ...rest } = patient;
        await db.patients.put(rest as Patient);
      }
      try {
        const tblPatients = getTableName('patients');
        await executeQuery(`UPDATE ${tblPatients} SET deleted_at = NULL WHERE id = ?`, [patientId]);
      } catch (err) {
        console.warn('Fallo al restaurar el paciente en Turso:', err);
      }
      showToastMsg('Paciente restaurado.', 'success');
      await loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al restaurar el paciente.', 'error');
    }
  };

  // Borrado definitivo: solo se ofrece dentro de la Papelera, sobre registros ya movidos ahí.
  const handlePermanentlyDeleteConsultation = async (consultationId: string) => {
    if (!window.confirm('¿Eliminar esta visita PARA SIEMPRE? Esta acción no se puede deshacer.')) {
      return;
    }
    try {
      await db.prescriptions.where('consultationId').equals(consultationId).delete();
      await db.consultation_steps.where('consultationId').equals(consultationId).delete();
      await db.consultations.delete(consultationId);

      try {
        const tblConsultations = getTableName('consultations');
        const tblSteps = getTableName('consultation_steps');
        const tblPrescriptions = getTableName('prescriptions');
        await executeQuery(`DELETE FROM ${tblPrescriptions} WHERE consultation_id = ?`, [consultationId]);
        await executeQuery(`DELETE FROM ${tblSteps} WHERE consultation_id = ?`, [consultationId]);
        await executeQuery(`DELETE FROM ${tblConsultations} WHERE id = ?`, [consultationId]);
      } catch (err) {
        console.warn('Fallo al eliminar de Turso:', err);
      }

      showToastMsg('Visita eliminada permanentemente.', 'success');
      await loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al eliminar la visita.', 'error');
    }
  };

  const handlePermanentlyDeletePatient = async (patientId: string) => {
    if (!window.confirm('¿Eliminar este paciente PARA SIEMPRE, junto con TODAS sus consultas, prescripciones e historial clínico? Esta acción no se puede deshacer.')) {
      return;
    }
    try {
      const consultationsToDelete = records.filter(r => r.patientId === patientId);

      for (const c of consultationsToDelete) {
        await db.prescriptions.where('consultationId').equals(c.id).delete();
        await db.consultation_steps.where('consultationId').equals(c.id).delete();
        await db.consultations.delete(c.id);
      }
      await db.anamnesis.where('patientId').equals(patientId).delete();
      await db.patients.delete(patientId);

      try {
        const tblConsultations = getTableName('consultations');
        const tblSteps = getTableName('consultation_steps');
        const tblPrescriptions = getTableName('prescriptions');
        const tblAnamnesis = getTableName('anamnesis');
        const tblPatients = getTableName('patients');

        for (const c of consultationsToDelete) {
          await executeQuery(`DELETE FROM ${tblPrescriptions} WHERE consultation_id = ?`, [c.id]);
          await executeQuery(`DELETE FROM ${tblSteps} WHERE consultation_id = ?`, [c.id]);
          await executeQuery(`DELETE FROM ${tblConsultations} WHERE id = ?`, [c.id]);
        }
        await executeQuery(`DELETE FROM ${tblAnamnesis} WHERE patient_id = ?`, [patientId]);
        await executeQuery(`DELETE FROM ${tblPatients} WHERE id = ?`, [patientId]);
      } catch (err) {
        console.warn('Fallo al eliminar del servidor Turso:', err);
      }

      showToastMsg('Expediente del paciente eliminado permanentemente.', 'success');
      await loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al eliminar el expediente del paciente.', 'error');
    }
  };

  // Hay algo que perder si se descarta la ficha ahora mismo: datos de identificación del paciente,
  // notas clínicas, o cualquier paso/prescripción ya armado en el protocolo. Se usa tanto para decidir
  // si vale la pena autoguardar un borrador como para decidir si hay que confirmar antes de borrar todo.
  const hasMeaningfulDraftContent = (): boolean => {
    return !!(
      patientForm.firstName.trim() ||
      patientForm.lastName.trim() ||
      patientForm.phone.trim() ||
      patientForm.medicalDiagnosis.trim() ||
      patientForm.clinicalNotes.trim() ||
      patientForm.allergies.trim() ||
      patientForm.medicalConditions.trim() ||
      patientForm.recommendations.trim() ||
      patientForm.beforeImageUrl ||
      patientForm.afterImageUrl ||
      currentSteps.length > 0 ||
      prescriptionsList.length > 0
    );
  };

  // Restaura, una sola vez al montar, el borrador de la Ficha guardado localmente en la sesión
  // anterior (p. ej. si se cerró/recargó el navegador a medio capturar un caso nuevo).
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    try {
      const raw = localStorage.getItem(FICHA_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== 'object' || !draft.patientForm) return;

      setPatientForm(prev => ({ ...prev, ...draft.patientForm }));
      if (Array.isArray(draft.currentSteps)) setCurrentSteps(draft.currentSteps);
      if (Array.isArray(draft.prescriptionsList)) setPrescriptionsList(draft.prescriptionsList);
      if (typeof draft.customConditionInput === 'string') setCustomConditionInput(draft.customConditionInput);
      if (typeof draft.selectedPatientId === 'string') setSelectedPatientId(draft.selectedPatientId);
      if (typeof draft.activeConsultationId === 'string') setActiveConsultationId(draft.activeConsultationId);
      if (draft.activeFacialZones && typeof draft.activeFacialZones === 'object') setActiveFacialZones(draft.activeFacialZones);
      setDraftSavedAt(typeof draft.savedAt === 'number' ? draft.savedAt : Date.now());
      showToastMsg('📝 Se recuperó un borrador sin guardar de tu ficha anterior. Revísalo y confirma antes de continuar.', 'info');
    } catch (err) {
      console.warn('No se pudo recuperar el borrador local de la ficha:', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autoguarda (con un pequeño debounce para no escribir en cada tecla) el estado en curso de la
  // Ficha en localStorage. Si el especialista deja el formulario vacío otra vez (guardó, limpió, o
  // nunca escribió nada), no deja un borrador fantasma atrás.
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    const timer = setTimeout(() => {
      if (!hasMeaningfulDraftContent()) {
        localStorage.removeItem(FICHA_DRAFT_KEY);
        setDraftSavedAt(null);
        return;
      }
      const savedAt = Date.now();
      try {
        localStorage.setItem(FICHA_DRAFT_KEY, JSON.stringify({
          patientForm, currentSteps, prescriptionsList, customConditionInput,
          selectedPatientId, activeConsultationId, activeFacialZones, savedAt
        }));
        setDraftSavedAt(savedAt);
      } catch (err) {
        console.warn('No se pudo autoguardar el borrador local de la ficha:', err);
      }
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientForm, currentSteps, prescriptionsList, customConditionInput, selectedPatientId, activeConsultationId, activeFacialZones]);

  // Aviso nativo del navegador si se intenta cerrar/recargar la pestaña con datos sin guardar. El
  // borrador local ya protege contra la pérdida real, pero prevenir el cierre accidental de entrada
  // es mejor que depender siempre de la recuperación.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasMeaningfulDraftContent()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientForm, currentSteps, prescriptionsList]);

  // `skipConfirm` se usa cuando la ficha ya se descarta por una razón legítima que el especialista
  // ya confirmó por otra vía (guardado exitoso, o el paciente/visita actualmente cargado se acaba de
  // enviar a la papelera): pedir una segunda confirmación ahí solo sería fricción sin sentido. En
  // cualquier otro caso (botón "Limpiar Ficha", "Nueva Consulta/Limpiar", o cambiar de paciente en el
  // selector a medio capturar), si hay datos sin guardar se confirma antes de borrarlos.
  const resetPatientForm = (opts?: { skipConfirm?: boolean }) => {
    if (!opts?.skipConfirm && hasMeaningfulDraftContent()) {
      const confirmed = window.confirm('Hay información sin guardar en esta ficha (datos del paciente, protocolo o prescripciones). Si continúas, se perderá. ¿Deseas descartarla?');
      if (!confirmed) return;
    }
    localStorage.removeItem(FICHA_DRAFT_KEY);
    setDraftSavedAt(null);
    setSelectedPatientId('');
    setActiveConsultationId('');
    setCustomConditionInput('');
    setEditingStepIndex(null);
    setPatientForm({
      id: '',
      firstName: '',
      lastName: '',
      dateOfBirth: '',
      email: '',
      phone: '',
      medicalDiagnosis: '',
      surgicalHistory: '',
      allergiesCosmetics: '[]',
      currentMedications: '[]',
      lifestyleMetrics: '{}',
      skinBiotype: '',
      fitzpatrickScale: 1,
      skinConditions: '[]',
      clinicalNotes: '',
      state: 'Borrador',
      allergies: '',
      medicalConditions: '',
      recommendations: '',
      consentAccepted: false,
      beforeImageUrl: '',
      afterImageUrl: '',
      signatureData: ''
    });
    setSignatureValid(false);
    setCurrentSteps([]);
    setPrescriptionsList([]);
    setActiveFacialZones(Object.fromEntries(Object.keys(FACIAL_ZONES).map(k => [k, false])));
  };

  // ----------------------------------------------------
  // PDF VECTOR COMPILER (@react-pdf/renderer)
  // ----------------------------------------------------
  const triggerPdfDownload = async (type: 'ficha' | 'receta', customPatient?: Patient, customConsultation?: Consultation) => {
    setIsPdfModalOpen(false);
    showToastMsg('Compilando expediente en PDF...', 'success');

    try {
      const activePatient: Patient = customPatient || {
        id: patientForm.id || 'P-0001',
        firstNameEncrypted: patientForm.firstName || 'Paciente',
        lastNameEncrypted: patientForm.lastName || 'Prueba',
        dateOfBirth: patientForm.dateOfBirth || '2000-01-01',
        emailHashed: '',
        phoneEncrypted: patientForm.phone || '0000000000',
        createdAt: '',
        updatedAt: ''
      };

      const activeConsultation: Consultation = customConsultation || {
        id: patientForm.id || 'C-2026-0001',
        patientId: activePatient.id,
        providerId: 'clinica_dermatique',
        visitDate: new Date().toISOString(),
        skinBiotype: patientForm.skinBiotype || 'Eudérmica / Normal',
        fitzpatrickScale: patientForm.fitzpatrickScale,
        skinConditions: patientForm.skinConditions,
        medicalDiagnosis: patientForm.medicalDiagnosis || 'Ninguno',
        clinicalNotes: patientForm.clinicalNotes || 'Sin notas adicionales.',
        state: patientForm.state,
        steps: currentSteps,
        prescriptions: prescriptionsList,
        allergies: patientForm.allergies || '',
        medicalConditions: patientForm.medicalConditions || '',
        // No condicionar por dispositivo: si el consentimiento ya se obtuvo por cualquier medio
        // (checkbox en un guardado previo desde escritorio, o firma dibujada en touch), editar el
        // registro desde el otro tipo de dispositivo sin volver a firmar/marcar NO debe revocarlo
        // en silencio. Por eso es un OR monótono, no una elección exclusiva por isTouchDevice.
        consentAccepted: (patientForm.consentAccepted || false) || signatureValid,
        signatureData: patientForm.signatureData || undefined
      };

      const doc = <ClinicalReportPDF patient={activePatient} consultation={activeConsultation} type={type} />;
      const blob = await pdf(doc).toBlob();
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `${type === 'ficha' ? 'Ficha_Clinica' : 'Receta_Apoyo'}_${activePatient.firstNameEncrypted}_${activeConsultation.id}.pdf`;
      link.click();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al generar el PDF.', 'error');
    }
  };

  const handleEditConsultation = async (c: Consultation) => {
    // Cargar un expediente distinto desde "Expedientes Clínicos" pisa lo que esté a medio capturar
    // en el Generador (p. ej. un paciente nuevo aún sin guardar); se confirma antes de descartarlo.
    if (hasMeaningfulDraftContent()) {
      const confirmed = window.confirm('Hay información sin guardar en el Generador de Fichas. Si cargas este expediente, se perderá. ¿Deseas continuar?');
      if (!confirmed) return;
    }
    localStorage.removeItem(FICHA_DRAFT_KEY);
    setDraftSavedAt(null);

    const pat = patients.find(p => p.id === c.patientId);
    setSelectedPatientId(c.patientId);
    setActiveConsultationId(c.id);

    // Resolve steps and prescriptions
    const steps = await db.consultation_steps.where('consultationId').equals(c.id).toArray();
    const prescriptions = await db.prescriptions.where('consultationId').equals(c.id).toArray();
    
    let condList: string[] = [];
    try {
      condList = JSON.parse(c.skinConditions || '[]');
    } catch(e) {}
    const customCond = condList.find(cond => !['Deshidratada', 'Asfixiada/ocluida', 'Sensible', 'Acneica', 'Desvitalizada', 'Poro fino', 'Poro dilatado'].includes(cond));
    setCustomConditionInput(customCond || '');

    setPatientForm({
      id: c.id,
      firstName: pat ? pat.firstNameEncrypted : '',
      lastName: pat ? pat.lastNameEncrypted : '',
      dateOfBirth: pat ? pat.dateOfBirth : '',
      email: '',
      phone: pat ? pat.phoneEncrypted : '',
      medicalDiagnosis: c.medicalDiagnosis || '',
      surgicalHistory: '',
      allergiesCosmetics: '[]',
      currentMedications: '[]',
      lifestyleMetrics: '{}',
      skinBiotype: c.skinBiotype,
      fitzpatrickScale: c.fitzpatrickScale,
      skinConditions: c.skinConditions || '[]',
      clinicalNotes: c.clinicalNotes || '',
      state: c.state,
      allergies: c.allergies || '',
      medicalConditions: c.medicalConditions || '',
      recommendations: c.recommendations || '',
      consentAccepted: c.consentAccepted || false,
      beforeImageUrl: c.beforeImageUrl || '',
      afterImageUrl: c.afterImageUrl || '',
      signatureData: c.signatureData || ''
    });
    setSignatureValid(!!c.signatureData);

    const anam = await db.anamnesis.where('patientId').equals(c.patientId).first();
    if (anam) {
      setPatientForm(prev => ({
        ...prev,
        surgicalHistory: anam.surgicalHistory || '',
        allergiesCosmetics: anam.allergiesCosmetics || '[]',
        currentMedications: anam.currentMedications || '[]',
        lifestyleMetrics: anam.lifestyleMetrics || '{}'
      }));
    }
    
    setCurrentSteps(steps.sort((a, b) => a.stepOrder - b.stepOrder));
    setPrescriptionsList(prescriptions);
    setActiveTab('generator');
    showToastMsg('Expediente cargado en el Generador.', 'success');
  };

  // ----------------------------------------------------
  // FORMULATION LAB & CATALOG MUTATIONS
  // ----------------------------------------------------
  const handleProductIngredientSearch = (val: string) => {
    setFormIngredientInput(val);
    if (!val.trim()) {
      setIngredientSuggestions([]);
      return;
    }
    const matches = ingredients.filter(i => i.name.toLowerCase().includes(val.toLowerCase())).slice(0, 5);
    setIngredientSuggestions(matches);
  };

  const selectFormIngredient = (name: string, action: string) => {
    setFormIngredientInput(name);
    setFormIngredientAction(action);
    setIngredientSuggestions([]);
    setShowActionDropdown(false);
  };

  const handleProductActionSearch = (val: string) => {
    setFormIngredientAction(val);
    if (!val.trim()) {
      setActionSuggestions(allCapturedActions.slice(0, 8));
    } else {
      const queryLower = val.toLowerCase().trim();
      const filtered = allCapturedActions.filter(act => act.toLowerCase().includes(queryLower)).slice(0, 8);
      setActionSuggestions(filtered);
    }
    setShowActionDropdown(true);
  };

  const selectFormAction = (act: string) => {
    setFormIngredientAction(act);
    setShowActionDropdown(false);
  };

  const handleBrandSearch = (val: string) => {
    setProductForm(prev => ({ ...prev, brandLine: val }));
    if (!val.trim()) {
      setBrandSuggestions(allCapturedBrands.slice(0, 8));
    } else {
      const q = val.toLowerCase().trim();
      setBrandSuggestions(allCapturedBrands.filter(b => b.toLowerCase().includes(q)).slice(0, 8));
    }
    setShowBrandDropdown(true);
  };

  const handleAddIngredientToForm = () => {
    if (!formIngredientInput.trim()) return;
    if (formIngredientsList.some(i => i.name.toLowerCase() === formIngredientInput.toLowerCase())) {
      showToastMsg('Activo ya añadido.', 'error');
      return;
    }
    setFormIngredientsList(prev => [...prev, { name: formIngredientInput, action: formIngredientAction || 'Acción general' }]);
    setFormIngredientInput('');
    setFormIngredientAction('');
  };

  const removeIngredientFromForm = (idx: number) => {
    const next = [...formIngredientsList];
    next.splice(idx, 1);
    setFormIngredientsList(next);
  };

  const editIngredientInForm = (idx: number) => {
    const ing = formIngredientsList[idx];
    if (!ing) return;
    setFormIngredientInput(ing.name);
    setFormIngredientAction(ing.action);
    removeIngredientFromForm(idx);
  };

  const handleEditProductClick = (p: Product) => {
    setIsProductFormOpen(true);
    setIsEditProduct(true);
    
    let parsedActives: { name: string; action: string }[] = [];
    try {
      const actives = JSON.parse(p.activeIngredients) as string[];
      const actions = JSON.parse(p.physiologicalActions) as string[];
      actives.forEach((act, idx) => {
        parsedActives.push({ name: act, action: actions[idx] || '' });
      });
    } catch(e) {}
    
    setProductForm({
      id: p.id,
      sku: p.sku,
      name: p.name,
      brandLine: p.brandLine,
      productType: p.productType || inferProductType(p.name, p.brandLine),
      retailPrice: String(p.retailPrice),
      isProfessionalUse: p.isProfessionalUse,
      activeIngredients: p.activeIngredients,
      physiologicalActions: p.physiologicalActions,
      skinBiotypes: p.skinBiotypes || '[]',
      stockQuantity: p.stockQuantity !== undefined && p.stockQuantity !== null ? String(p.stockQuantity) : '',
      costPrice: p.costPrice !== undefined && p.costPrice !== null ? String(p.costPrice) : '',
      reorderPoint: p.reorderPoint !== undefined && p.reorderPoint !== null ? String(p.reorderPoint) : ''
    });
    setFormIngredientsList(parsedActives);
  };

  const handleDeleteProduct = async (id: string) => {
    if (!window.confirm('¿Está seguro de eliminar este producto del catálogo?')) return;
    try {
      if (navigator.onLine) {
        const tblProducts = getTableName('products');
        await executeQuery(`DELETE FROM ${tblProducts} WHERE id = ?`, [id]);
      }
      await db.products.delete(id);
      showToastMsg('Producto eliminado del catálogo.', 'success');
      loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al eliminar producto.', 'error');
    }
  };

  // Aplica un cambio (renombrar/actualizar acción, o eliminar) de un activo a todos los
  // productos del catálogo que lo contienen. `transform` devuelve null para eliminar el activo.
  const applyIngredientChangeToAllProducts = async (
    matchName: string,
    transform: (name: string, action: string) => { name: string; action: string } | null
  ) => {
    const tblProducts = getTableName('products');
    const matchLower = matchName.toLowerCase();
    const affected = products.filter(p => parseStringList(p.activeIngredients).some(n => n.toLowerCase() === matchLower));

    for (const p of affected) {
      const actives = parseStringList(p.activeIngredients);
      const actions = parseStringList(p.physiologicalActions);
      const nextActives: string[] = [];
      const nextActions: string[] = [];
      actives.forEach((act, idx) => {
        const currentAction = actions[idx] || '';
        if (act.toLowerCase() === matchLower) {
          const result = transform(act, currentAction);
          if (result) {
            nextActives.push(result.name);
            nextActions.push(result.action);
          }
        } else {
          nextActives.push(act);
          nextActions.push(currentAction);
        }
      });

      const updated: Product = { ...p, activeIngredients: JSON.stringify(nextActives), physiologicalActions: JSON.stringify(nextActions) };
      await db.products.put(updated);
      if (navigator.onLine) {
        try {
          await executeQuery(
            `UPDATE ${tblProducts} SET active_ingredients = ?, physiological_actions = ? WHERE id = ?`,
            [updated.activeIngredients, updated.physiologicalActions, updated.id]
          );
        } catch (e) {
          console.warn('Fallo temporal al sincronizar activo actualizado en Turso para el producto', p.id, e);
        }
      }
    }

    await loadMasterCatalogs();
    return affected.length;
  };

  const handleEditCatalogIngredient = async (originalName: string, newName: string, newAction: string) => {
    const trimmedName = newName.trim();
    const trimmedAction = newAction.trim();
    if (!trimmedName) {
      showToastMsg('El nombre del activo no puede estar vacío.', 'error');
      return;
    }
    const count = await applyIngredientChangeToAllProducts(originalName, () => ({ name: trimmedName, action: trimmedAction || 'Acción general' }));
    setEditingCatalogIngredient(null);
    showToastMsg(`Activo actualizado en ${count} producto(s) del catálogo.`, 'success');
  };

  const handleDeleteCatalogIngredient = async (name: string) => {
    if (!window.confirm(`¿Eliminar "${name}" de TODOS los productos del catálogo que lo contienen? Esta acción no se puede deshacer.`)) return;
    const count = await applyIngredientChangeToAllProducts(name, () => null);
    showToastMsg(`Activo eliminado de ${count} producto(s) del catálogo.`, 'success');
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productForm.name || !productForm.brandLine) {
      showToastMsg('El nombre comercial y la marca son obligatorios.', 'error');
      return;
    }

    // Auto-incluir ingrediente activo pendiente si el usuario escribió pero no hizo clic en "Ligar Activo"
    let currentIngredients = [...formIngredientsList];
    if (formIngredientInput.trim()) {
      const pendingName = formIngredientInput.trim();
      const pendingAction = formIngredientAction.trim() || 'Acción general';
      if (!currentIngredients.some(i => i.name.toLowerCase() === pendingName.toLowerCase())) {
        currentIngredients.push({ name: pendingName, action: pendingAction });
      }
    }

    const actives = currentIngredients.map(i => i.name);
    const actions = currentIngredients.map(i => i.action);
    const pType = productForm.productType || inferProductType(productForm.name, productForm.brandLine);

    const generatedSku = productForm.sku.trim() || `SKU-${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`;
    const generatedId = productForm.id || `PROD-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

    const newProd: Product = {
      id: generatedId,
      sku: generatedSku,
      name: productForm.name.trim(),
      brandLine: productForm.brandLine.trim(),
      productType: pType,
      retailPrice: parseFloat(productForm.retailPrice) || 0,
      isProfessionalUse: productForm.isProfessionalUse,
      activeIngredients: JSON.stringify(actives),
      physiologicalActions: JSON.stringify(actions),
      skinBiotypes: productForm.skinBiotypes || '[]',
      stockQuantity: productForm.stockQuantity.trim() ? parseInt(productForm.stockQuantity, 10) : undefined,
      costPrice: productForm.costPrice.trim() ? parseFloat(productForm.costPrice) : undefined,
      reorderPoint: productForm.reorderPoint.trim() ? parseInt(productForm.reorderPoint, 10) : undefined
    };

    try {
      await saveProduct(newProd);
    } catch (localErr) {
      console.error("Error al guardar producto localmente:", localErr);
      showToastMsg('Error al guardar el producto localmente.', 'error');
      return;
    }

    showToastMsg('Producto guardado exitosamente en catálogo.', 'success');
    setIsProductFormOpen(false);
    setFormIngredientInput('');
    setFormIngredientAction('');
    setFormIngredientsList([]);
    await loadMasterCatalogs();
  };

  // ----------------------------------------------------
  // ANALYTICS ENGINE & CHARTS
  // ----------------------------------------------------
  // Calculate biotype statistics
  const totalPatients = records.length;
  const biotypeCounts = records.reduce((acc, curr) => {
    acc[curr.skinBiotype] = (acc[curr.skinBiotype] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const predominantBiotype = Object.entries(biotypeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Ninguno';

  // ----------------------------------------------------
  // ESTABLISHED ROUTINES DATABASE & LOGIC (APOYO EN CASA)
  // ----------------------------------------------------
  interface RoutineStepTemplate {
    stepName: string;
    keywords: string[];
    defaultProductName: string;
    defaultBrand: string;
    defaultActiveIngredients: string;
    defaultActions: string;
    dosageInstructions: string;
    applicationFrequency: string;
  }

  const ESTABLISHED_ROUTINES: Record<string, { Dia: RoutineStepTemplate[]; Noche: RoutineStepTemplate[] }> = {
    "Hidratante": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "hidratante", "hydra", "sensible", "aloe", "leche"],
          defaultProductName: "Leche Limpiadora Hidratante",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Aloe Vera, Manzanilla",
          defaultActions: "Limpieza suave y aportación de humedad",
          dosageInstructions: "Aplicar sobre rostro húmedo, masajear suavemente y enjuagar con abundante agua.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "hidratante", "aquatherm", "agua termal", "loto"],
          defaultProductName: "Loción Hidratante Termal",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Agua Termal, Prebióticos",
          defaultActions: "Equilibrar el pH e hidratar",
          dosageInstructions: "Rociar sobre el rostro limpio o aplicar con un disco de algodón mediante toques suaves.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "suero", "hialurónico", "hyaluronic", "concentrado"],
          defaultProductName: "Serum Concentrado de Ácido Hialurónico",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Hialurónico al 2%, Pantenol",
          defaultActions: "Hidratación profunda y relleno de líneas",
          dosageInstructions: "Aplicar 3-4 gotas en rostro, cuello y escote, realizando lisajes hasta su total absorción.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "emulsión", "hidratante", "comforting", "royal jelly", "jalea real"],
          defaultProductName: "Emulsión Hidratante Comfort",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Jalea Real, Extracto de Poria Cocos",
          defaultActions: "Nutrición, protección e hidratación duradera",
          dosageInstructions: "Aplicar una pequeña cantidad en rostro y cuello con movimientos circulares ascendentes.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "bloqueador", "sunscreen", "fps"],
          defaultProductName: "Protector Solar Hidratante FPS 50+",
          defaultBrand: "General",
          defaultActiveIngredients: "Filtros UVA/UVB, Vitamina E",
          defaultActions: "Protección solar y antioxidante",
          dosageInstructions: "Aplicar generosamente 30 minutos antes de la exposición solar. Reaplicar cada 4 horas.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "hidratante", "hydra", "sensible", "aloe", "leche"],
          defaultProductName: "Leche Limpiadora Hidratante",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Aloe Vera, Manzanilla",
          defaultActions: "Limpieza suave y aportación de humedad",
          dosageInstructions: "Aplicar sobre rostro húmedo, masajear suavemente y enjuagar con abundante agua.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "hidratante", "aquatherm", "agua termal", "loto"],
          defaultProductName: "Loción Hidratante Termal",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Agua Termal, Prebióticos",
          defaultActions: "Equilibrar el pH e hidratar",
          dosageInstructions: "Rociar sobre el rostro limpio o aplicar con un disco de algodón mediante toques suaves.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "suero", "hialurónico", "hyaluronic", "concentrado"],
          defaultProductName: "Serum Concentrado de Ácido Hialurónico",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Hialurónico al 2%, Pantenol",
          defaultActions: "Hidratación profunda y relleno de líneas",
          dosageInstructions: "Aplicar 3-4 gotas en rostro, cuello y escote, realizando lisajes hasta su total absorción.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "night", "reparadora", "nourishing", "nutritiva"],
          defaultProductName: "Crema Ultra-Hidratante de Noche",
          defaultBrand: "Casmara",
          defaultActiveIngredients: "Manteca de Karité, Ácido Hialurónico, Ceramidas",
          defaultActions: "Reparación intensiva y nutrición nocturna",
          dosageInstructions: "Aplicar por la noche sobre rostro y cuello limpios con suave masaje.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "Control de Melanogenesis": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "aclarante", "brightening", "glicólico", "facial wash"],
          defaultProductName: "Gel Limpiador Aclarante",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Glicólico, Niacinamida",
          defaultActions: "Limpieza profunda y microexfoliación aclaradora",
          dosageInstructions: "Aplicar en rostro húmedo, masajear en círculos evitando ojos y enjuagar con agua fría.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "aclarante", "tónico", "iluminadora", "vitamina c"],
          defaultProductName: "Loción Tónica Iluminadora Vitamina C",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Vitamina C Estabilizada, Extracto de Regaliz",
          defaultActions: "Antioxidante, control de melanina e iluminación",
          dosageInstructions: "Aplicar con palmaditas suaves en todo el rostro usando las manos limpias.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "vitamina c", "melano", "antioxidante", "c-vit"],
          defaultProductName: "Serum Antioxidante Vitamina C y Ferúlico",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Vitamina C Pura al 10%, Ácido Ferúlico",
          defaultActions: "Previene la oxidación de melanina y aporta luminosidad",
          dosageInstructions: "Aplicar 3-5 gotas sobre el rostro limpio, deslizando suavemente.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "despigmentante", "melanogel", "pigment", "aclaradora"],
          defaultProductName: "Crema Control de Melanogénesis FPS 20",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Kójico, Ácido Fítico, Niacinamida",
          defaultActions: "Inhibición de la tirosinasa y control de pigmentación",
          dosageInstructions: "Aplicar una capa delgada de manera uniforme en zonas con tendencia a manchas.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "despigmentante", "sunscreen", "physical", "pantalla"],
          defaultProductName: "Pantalla Solar Despigmentante FPS 50+",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Filtros físicos, Activos despigmentantes",
          defaultActions: "Alta protección solar y prevención de nuevas manchas",
          dosageInstructions: "Aplicar abundantemente y de forma homogénea. Reaplicar rigurosamente cada 3 horas.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "aclarante", "brightening", "glicólico", "facial wash"],
          defaultProductName: "Gel Limpiador Aclarante",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Glicólico, Niacinamida",
          defaultActions: "Limpieza profunda y microexfoliación aclaradora",
          dosageInstructions: "Aplicar en rostro húmedo, masajear en círculos evitando ojos y enjuagar con agua fría.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "aclarante", "tónico", "iluminadora", "vitamina c"],
          defaultProductName: "Loción Tónica Iluminadora Vitamina C",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Vitamina C Estabilizada, Extracto de Regaliz",
          defaultActions: "Antioxidante, control de melanina e iluminación",
          dosageInstructions: "Aplicar con palmaditas suaves en todo el rostro usando las manos limpias.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "melanogel", "despigmentante", "concentrado", "retinol", "kójico"],
          defaultProductName: "Gel Concentrado Regulador de Melanogénesis",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Kójico, Arbutina, Ácido Tranexámico",
          defaultActions: "Tratamiento intensivo bloqueador de la melanina",
          dosageInstructions: "Aplicar de manera focalizada en las manchas o en todo el rostro si es generalizado.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "despigmentante", "aclarante", "melanogel", "renovadora"],
          defaultProductName: "Crema Renovadora Despigmentante de Noche",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Ácido Mandélico, Niacinamida, Retinol Liposomado",
          defaultActions: "Exfoliación suave, renovación y aclaración nocturna",
          dosageInstructions: "Aplicar por la noche sobre la piel limpia y seca. Iniciar en noches alternadas si hay sensibilidad.",
          applicationFrequency: "Noches alternas o diario según tolerancia"
        }
      ]
    },
    "Regenerante": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "suave", "sensible", "calmante", "espuma", "foam"],
          defaultProductName: "Espuma Limpiadora Regeneradora con Cica",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Centella Asiática, Pantenol",
          defaultActions: "Limpieza respetuosa que promueve la barrera cutánea",
          dosageInstructions: "Aplicar espuma en la palma de la mano, masajear el rostro y aclarar con agua tibia.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "calmante", "regenerante", "rosa mosqueta", "rosehip"],
          defaultProductName: "Loción Tónica de Rosa Mosqueta",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Extracto de Rosa Mosqueta, Alantoína",
          defaultActions: "Tonificación, calma y estimulación celular",
          dosageInstructions: "Aplicar con bruma suave o toques con algodón.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "regenerante", "repair", "cica", "factor de crecimiento", "factores", "stem cell"],
          defaultProductName: "Serum Regenerante Reparador Intensivo",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Centella Asiática, Factores de Crecimiento, Alantoína",
          defaultActions: "Aceleración de la renovación celular y cicatrización",
          dosageInstructions: "Colocar 4 gotas en las yemas de los dedos y presionar suavemente sobre el rostro.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "regeneradora", "repair", "cica", "elastina", "colágeno"],
          defaultProductName: "Crema Activa Regenerante de Día",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Colágeno Soluble, Elastina, Ácido Hialurónico",
          defaultActions: "Restauración de elasticidad y sostén dérmico",
          dosageInstructions: "Extender sobre rostro y escote con suaves masajes hacia afuera.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "sunscreen", "fps", "cicatrizante", "barrier"],
          defaultProductName: "Protector Solar Dermatológico Reparador FPS 50+",
          defaultBrand: "Casmara",
          defaultActiveIngredients: "Filtros solares de amplio espectro, Aloe Vera",
          defaultActions: "Protección y regeneración de piel expuesta",
          dosageInstructions: "Aplicar generosamente como último paso de la rutina matutina.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "suave", "sensible", "calmante", "espuma", "foam"],
          defaultProductName: "Espuma Limpiadora Regeneradora con Cica",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Centella Asiática, Pantenol",
          defaultActions: "Limpieza respetuosa que promueve la barrera cutánea",
          dosageInstructions: "Aplicar espuma en la palma de la mano, masajear el rostro y aclarar con agua tibia.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "calmante", "regenerante", "rosa mosqueta", "rosehip"],
          defaultProductName: "Loción Tónica de Rosa Mosqueta",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Extracto de Rosa Mosqueta, Alantoína",
          defaultActions: "Tonificación, calma y estimulación celular",
          dosageInstructions: "Aplicar con bruma suave o toques con algodón.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "regenerante", "repair", "cica", "factor de crecimiento", "factores", "stem cell"],
          defaultProductName: "Serum Regenerante Reparador Intensivo",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Centella Asiática, Factores de Crecimiento, Alantoína",
          defaultActions: "Aceleración de la renovación celular y cicatrización",
          dosageInstructions: "Colocar 4 gotas en las yemas de los dedos y presionar suavemente sobre el rostro.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "regeneradora", "royal jelly", "jalea real", "nutritiva", "repair"],
          defaultProductName: "Crema Nutritiva Regeneradora Jalea Real",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Jalea Real, Aceite de Rosa Mosqueta, Pantenol",
          defaultActions: "Nutrición y reestructuración dérmica nocturna profunda",
          dosageInstructions: "Aplicar por la noche en rostro, cuello y escote limpios, masajeando hasta absorber.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "Hidratacion piel grasa": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["grasa", "sebo", "salicílico", "purificante", "acné", "seboregulator"],
          defaultProductName: "Gel Purificante Seborregulador",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Ácido Salicílico, Extracto de Árbol de Té",
          defaultActions: "Control de grasa y limpieza de poros",
          dosageInstructions: "Lavar el rostro por la mañana haciendo espuma suave y retirar con agua tibia.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "balance", "grasa", "sebo", "astringente", "equilibrante"],
          defaultProductName: "Loción Equilibrante Piel Grasa",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Zinc PCA, Hamamelis",
          defaultActions: "Matificación y regulación de la producción sebácea",
          dosageInstructions: "Brumizar a distancia o aplicar con pequeños toques sin arrastrar.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "grasa", "niacinamida", "sebo", "matificante", "oil free"],
          defaultProductName: "Serum Matificante Niacinamida 10%",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Niacinamida, Zinc PCA",
          defaultActions: "Regulación de sebo, hidratación ligera y minimizador de poros",
          dosageInstructions: "Aplicar 3 gotas en el rostro limpio extendiéndolo de forma homogénea.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "gel", "grasa", "balance", "sebo", "matificante", "gel-crema"],
          defaultProductName: "Crema Balance Equilibrante Mate (Gel-Cream)",
          defaultBrand: "Casmara",
          defaultActiveIngredients: "Extracto de Flor de Loto, Alantoína",
          defaultActions: "Hidratación libre de aceites y control de brillos",
          dosageInstructions: "Aplicar en rostro limpio mediante ligeros toques hasta su total absorción.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "grasa", "oil-free", "toque seco", "dry touch", "mate"],
          defaultProductName: "Protector Solar Toque Seco Mate FPS 50+",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Filtros solares inteligentes, Sílice matificante",
          defaultActions: "Protección solar sin aportar oleosidad ni brillos",
          dosageInstructions: "Aplicar en rostro y cuello como paso final de la rutina matutina.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["grasa", "sebo", "salicílico", "purificante", "acné", "seboregulator"],
          defaultProductName: "Gel Purificante Seborregulador",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Ácido Salicílico, Extracto de Árbol de Té",
          defaultActions: "Control de grasa y limpieza de poros",
          dosageInstructions: "Lavar el rostro por la noche haciendo espuma suave y retirar con agua tibia.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "balance", "grasa", "sebo", "astringente", "equilibrante"],
          defaultProductName: "Loción Equilibrante Piel Grasa",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Zinc PCA, Hamamelis",
          defaultActions: "Matificación y regulación de la producción sebácea",
          dosageInstructions: "Brumizar a distancia o aplicar con pequeños toques sin arrastrar.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "grasa", "niacinamida", "sebo", "matificante", "oil free"],
          defaultProductName: "Serum Matificante Niacinamida 10%",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Niacinamida, Zinc PCA",
          defaultActions: "Regulación de sebo, hidratación ligera y minimizador de poros",
          dosageInstructions: "Aplicar 3 gotas en el rostro limpio extendiéndolo de forma homogénea.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "gel", "grasa", "balance", "sebo", "seborreguladora", "renovadora"],
          defaultProductName: "Gel-Crema Renovadora y Seborreguladora de Noche",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Salicílico, Ácido Mandélico, Niacinamida",
          defaultActions: "Renovación celular suave, prevención de brotes e hidratación seborregulada",
          dosageInstructions: "Aplicar una ligera capa por la noche sobre el rostro limpio y seco.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "Despigmentante": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "aclarante", "brightening", "glicólico", "facial wash"],
          defaultProductName: "Gel Limpiador Despigmentante Aclarante",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Glicólico, Niacinamida",
          defaultActions: "Higiene y exfoliación biológica aclaradora",
          dosageInstructions: "Masajear con agua sobre el rostro para limpiar y enjuagar abundantemente.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "aclarante", "tónico", "iluminadora", "vitamina c"],
          defaultProductName: "Loción Tónica Despigmentante Iluminadora",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Vitamina C, Extracto de Regaliz",
          defaultActions: "Unificar tono e hidratar la piel",
          dosageInstructions: "Brumizar o aplicar suavemente con disco de algodón en toda la cara.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "vitamina c", "melano", "antioxidante", "c-vit"],
          defaultProductName: "Suero Despigmentante Antioxidante Vitamina C",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Vitamina C Pura al 10%, Ácido Ferúlico",
          defaultActions: "Combate la pigmentación y estimula colágeno",
          dosageInstructions: "Aplicar 4 gotas por la mañana y masajear con movimientos ascendentes.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "despigmentante", "melanogel", "pigment", "aclaradora"],
          defaultProductName: "Crema Activa Despigmentante de Día",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Ácido Fítico, Ácido Kójico, Niacinamida",
          defaultActions: "Inhibidor de melanogénesis e hidratación profunda",
          dosageInstructions: "Aplicar en todo el rostro o sobre zonas manchadas después del serum.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "despigmentante", "sunscreen", "physical", "pantalla"],
          defaultProductName: "Bloqueador Despigmentante Preventivo FPS 50+",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Filtros físicos, Activos aclarantes",
          defaultActions: "Protección total anti-manchas y antioxidante",
          dosageInstructions: "Aplicar como último paso. Reaplicar obligatoriamente cada 3 horas.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "aclarante", "brightening", "glicólico", "facial wash"],
          defaultProductName: "Gel Limpiador Despigmentante Aclarante",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Glicólico, Niacinamida",
          defaultActions: "Higiene y exfoliación biológica aclaradora",
          dosageInstructions: "Masajear con agua sobre el rostro para limpiar y enjuagar abundantemente.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "aclarante", "tónico", "iluminadora", "vitamina c"],
          defaultProductName: "Loción Tónica Despigmentante Iluminadora",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Vitamina C, Extracto de Regaliz",
          defaultActions: "Unificar tono e hidratar la piel",
          dosageInstructions: "Brumizar o aplicar suavemente con disco de algodón en toda la cara.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "melanogel", "despigmentante", "concentrado", "retinol", "kójico", "tranexámico"],
          defaultProductName: "Concentrado Despigmentante Intensivo de Noche",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Tranexámico, Ácido Kójico, Arbutina",
          defaultActions: "Ataque intensivo a las máculas e hiperpigmentación",
          dosageInstructions: "Aplicar 3 gotas focalizado en manchas por la noche sobre rostro seco.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "despigmentante", "aclarante", "melanogel", "renovadora", "mandélico", "glycolic"],
          defaultProductName: "Crema Despigmentante Renovadora Mandélica de Noche",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Ácido Mandélico, Retinol Liposomado, Resveratroles",
          defaultActions: "Acción exfoliante progresiva, aclarante y renovadora",
          dosageInstructions: "Aplicar capa ligera en la noche. Suspender temporalmente si hay enrojecimiento excesivo.",
          applicationFrequency: "Diario o noches alternadas"
        }
      ]
    },
    "reductivo de cuello": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "suave", "espuma", "facial wash"],
          defaultProductName: "Gel de Higiene Suave Facial y Cuello",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Aloe Vera, Alantoína",
          defaultActions: "Preparar la piel de cuello y escote",
          dosageInstructions: "Limpiar la zona del cuello con movimientos ascendentes suaves y enjuagar.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["cuello", "reductivo", "papada", "tensor", "neck", "serum", "ampolleta"],
          defaultProductName: "Serum Tensor y Reductor de Papada / Cuello",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Péptidos tensores, Cafeína vectorizada",
          defaultActions: "Acción lipolítica reductora de grasa localizada y tensora",
          dosageInstructions: "Aplicar en el contorno del óvalo facial y cuello, masajeando con los nudillos hacia arriba.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["cuello", "crema cuello", "neck", "papada", "firming neck", "reductivo", "tensora"],
          defaultProductName: "Crema Reductora Definidora de Cuello y Escote",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Extracto de Glaucina, Cafeína, Silicio Orgánico",
          defaultActions: "Drenante, reducción de tejido graso doble mentón",
          dosageInstructions: "Extender sobre cuello y escote mediante un masaje ascendente hasta la base de las orejas.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "sunscreen", "fps"],
          defaultProductName: "Protector Solar Anti-Fotoenvejecimiento FPS 50+",
          defaultBrand: "General",
          defaultActiveIngredients: "Filtros solares, Vitamina E, Coenzima Q10",
          defaultActions: "Evita la flacidez del cuello por fotoenvejecimiento",
          dosageInstructions: "Aplicar en la zona de cuello y escote antes de salir al sol.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "suave", "espuma", "facial wash"],
          defaultProductName: "Gel de Higiene Suave Facial y Cuello",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Aloe Vera, Alantoína",
          defaultActions: "Preparar la piel de cuello y escote",
          dosageInstructions: "Limpiar la zona del cuello con movimientos ascendentes suaves y enjuagar.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["cuello", "reductivo", "papada", "tensor", "neck", "serum", "ampolleta"],
          defaultProductName: "Serum Tensor y Reductor de Papada / Cuello",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Péptidos tensores, Cafeína vectorizada",
          defaultActions: "Acción lipolítica reductora de grasa localizada y tensora",
          dosageInstructions: "Aplicar en el contorno del óvalo facial y cuello, masajeando con los nudillos hacia arriba.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["cuello", "crema cuello", "neck", "papada", "firming neck", "reductivo", "tensora", "noche"],
          defaultProductName: "Crema Reductora Definidora de Cuello y Escote",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Extracto de Glaucina, Cafeína, Silicio Orgánico",
          defaultActions: "Drenante, reducción de tejido graso doble mentón",
          dosageInstructions: "Extender sobre cuello y escote mediante un masaje ascendente hasta la base de las orejas.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "reafirmante facial y cuello": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "regenerante", "suave", "leche", "cleansing milk"],
          defaultProductName: "Leche Cleanser Tenso-Activa",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Colágeno, Elastina",
          defaultActions: "Limpieza tónica que prepara la firmeza",
          dosageInstructions: "Limpiar cara y cuello suavemente, retirar con esponja húmeda.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "reafirmante", "dmae", "tensor"],
          defaultProductName: "Loción Reafirmante Tensora",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "DMAE, Silicio Orgánico",
          defaultActions: "Tonifica las fibras elásticas cutáneas",
          dosageInstructions: "Aplicar pulverizando sobre rostro y cuello, palmeando suavemente.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "reafirmante", "tensor", "firming", "lifting", "dmae", "tens-up"],
          defaultProductName: "Serum de Firmeza Intensiva DMAE",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "DMAE al 3%, Silicio, Péptidos Tensores",
          defaultActions: "Efecto lifting inmediato y reafirmante a largo plazo",
          dosageInstructions: "Colocar unas gotas y extender con las manos de forma ascendente en rostro y cuello.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "reafirmante", "tensor", "lifting", "firming", "collagen"],
          defaultProductName: "Crema Reafirmante Voluminizadora Facial y Cuello",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "DMAE, Ácido Hialurónico, Colágeno",
          defaultActions: "Redefinición del óvalo facial y turgencia",
          dosageInstructions: "Aplicar en cara, cuello y escote realizando masajes lisantes de abajo hacia arriba.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "tensor", "sunscreen", "firming"],
          defaultProductName: "Filtro Solar Reafirmante Antiedad FPS 50+",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Filtros solares, Extracto de Cacao antioxidante",
          defaultActions: "Protección solar y prevención de flacidez actínica",
          dosageInstructions: "Aplicar homogéneamente en rostro, orejas y cuello.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "regenerante", "suave", "leche", "cleansing milk"],
          defaultProductName: "Leche Cleanser Tenso-Activa",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Colágeno, Elastina",
          defaultActions: "Limpieza tónica que prepara la firmeza",
          dosageInstructions: "Limpiar cara y cuello suavemente, retirar con esponja húmeda.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "reafirmante", "dmae", "tensor"],
          defaultProductName: "Loción Reafirmante Tensora",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "DMAE, Silicio Orgánico",
          defaultActions: "Tonifica las fibras elásticas cutáneas",
          dosageInstructions: "Aplicar pulverizando sobre rostro y cuello, palmeando suavemente.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "reafirmante", "tensor", "firming", "lifting", "dmae", "tens-up"],
          defaultProductName: "Serum de Firmeza Intensiva DMAE",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "DMAE al 3%, Silicio, Péptidos Tensores",
          defaultActions: "Efecto lifting inmediato y reafirmante a largo plazo",
          dosageInstructions: "Colocar unas gotas y extender con las manos de forma ascendente en rostro y cuello.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "reafirmante", "nutritiva", "lifting", "firming", "night cream"],
          defaultProductName: "Crema Reestructurante Reafirmante Nocturna",
          defaultBrand: "Casmara",
          defaultActiveIngredients: "Coenzima Q10, Ácido Hialurónico, Péptidos de Colágeno",
          defaultActions: "Nutrición profunda y reestructuración celular nocturna",
          dosageInstructions: "Aplicar en cara y cuello limpios con suave masaje ascendente antes de dormir.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "anti envejecimiento piel grasa": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["grasa", "sebo", "limpiador", "salicílico", "purificante", "glycolic"],
          defaultProductName: "Gel Limpiador Renovador Ácido Glicólico",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Glicólico, Ácido Salicílico",
          defaultActions: "Eliminación de células muertas y seborregulación",
          dosageInstructions: "Aplicar sobre piel húmeda, masajear 1 minuto y enjuagar abundantemente.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "balance", "grasa", "sebo", "ácidos", "astringente"],
          defaultProductName: "Loción Astringente Renovadora Antiedad",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Ácido Glicólico, Niacinamida",
          defaultActions: "Disminuir poros y alisar textura",
          dosageInstructions: "Aplicar con disco de algodón dando toques en las zonas más grasas.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "retinol", "hialurónico", "grasa", "anti-age", "pore", "antienvejecimiento"],
          defaultProductName: "Serum Antiedad de Hidratación Ligera Hialurónica",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Ácido Hialurónico de bajo peso molecular, Zinc PCA",
          defaultActions: "Hidrata sin aportar grasa y rellena finas líneas",
          dosageInstructions: "Colocar 3 gotas y masajear. Textura toque seco de rápida absorción.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "gel", "grasa", "antiedad", "antiarrugas", "matificante", "gel-cream"],
          defaultProductName: "Gel-Crema Revitalizante Antiedad Libre de Aceite",
          defaultBrand: "Casmara",
          defaultActiveIngredients: "Vitamina C Liposomada, Coenzima Q10, Polvos matificantes",
          defaultActions: "Acción antienvejecimiento, luminosidad y control de brillo",
          dosageInstructions: "Extender una pequeña cantidad en rostro evitando contorno de ojos.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "grasa", "toque seco", "dry touch", "mate"],
          defaultProductName: "Filtro Solar Fluido Toque Seco FPS 50+",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Filtros de amplio espectro, Activos seborreguladores",
          defaultActions: "Protección solar y prevención del fotoenvejecimiento graso",
          dosageInstructions: "Aplicar por la mañana como último paso. Reaplicar al mediodía.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["grasa", "sebo", "limpiador", "salicílico", "purificante", "glycolic"],
          defaultProductName: "Gel Limpiador Renovador Ácido Glicólico",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Glicólico, Ácido Salicílico",
          defaultActions: "Eliminación de células muertas y seborregulación",
          dosageInstructions: "Aplicar sobre piel húmeda, masajear 1 minuto y enjuagar abundantemente.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "balance", "grasa", "sebo", "ácidos", "astringente"],
          defaultProductName: "Loción Astringente Renovadora Antiedad",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Ácido Glicólico, Niacinamida",
          defaultActions: "Disminuir poros y alisar textura",
          dosageInstructions: "Aplicar con disco de algodón dando toques en las zonas más grasas.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "retinol", "envejecimiento", "noche", "grasa", "renovador", "anti-age"],
          defaultProductName: "Serum Retinol Renovador Nocturno Piel Grasa",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Retinol Puro al 0.3%, Ácido Salicílico",
          defaultActions: "Estimula colágeno, reduce arrugas, manchas y sebo",
          dosageInstructions: "Aplicar 3 gotas de noche sobre el rostro limpio y seco. Iniciar progresivamente.",
          applicationFrequency: "De 2 a 3 veces por semana, aumentando frecuencia según tolerancia"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "gel", "grasa", "antiedad", "renovadora", "mandélico", "glycolic"],
          defaultProductName: "Crema Renovadora Ácido Mandélico y Niacinamida",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Ácido Mandélico al 8%, Niacinamida",
          defaultActions: "Renovación nocturna, alisa arrugas y controla la grasa",
          dosageInstructions: "Aplicar una fina capa por la noche sobre el rostro limpio.",
          applicationFrequency: "Diario por la noche (en noches que no se use Retinol)"
        }
      ]
    },
    "oxigenante": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "oxigenante", "detox", "espuma", "carbón", "pollution"],
          defaultProductName: "Espuma Limpiadora Oxigenante Detox",
          defaultBrand: "Casmara",
          defaultActiveIngredients: "Oxígeno Activo microencapsulado, Extracto de Té Verde",
          defaultActions: "Limpieza profunda de toxinas and oxigenación",
          dosageInstructions: "Aplicar en rostro húmedo, dejar actuar 30 segundos hasta que burbujee, enjuagar.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "oxigenante", "detox", "mist", "bruma"],
          defaultProductName: "Loción Tónica Bruma Anti-Polución",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Extracto de Moringa, Alga Marina",
          defaultActions: "Escudo antipolución y refrescante celular",
          dosageInstructions: "Brumizar a unos 20 cm del rostro y dejar absorber al aire.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "oxigenante", "oxygen", "detox", "antipolución", "energizante"],
          defaultProductName: "Suero Oxigenante Energizante Protector",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Detoxificantes celulares, Oxígeno vectorizado",
          defaultActions: "Estimula la respiración mitocondrial celular",
          dosageInstructions: "Aplicar sobre el rostro, realizando suaves toques ascendentes.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "oxigenante", "oxygen", "detox", "antipolución", "revitalizante"],
          defaultProductName: "Crema Hidratante Oxigenante Anti-Polución",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Citocinas protectoras, Oxígeno, Filtro de polución",
          defaultActions: "Protección ambiental y revitalización de pieles asfixiadas",
          dosageInstructions: "Aplicar en todo el rostro masajeando suavemente hasta su completa penetración.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "detox", "sunscreen", "fps"],
          defaultProductName: "Escudo Solar Urbano Antipolución FPS 50+",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Filtros de amplio espectro, Vitamina E antipolución",
          defaultActions: "Filtro UV de alto grado y protección ambiental urbana",
          dosageInstructions: "Aplicar como último paso protector por la mañana.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "oxigenante", "detox", "espuma", "carbón", "pollution"],
          defaultProductName: "Espuma Limpiadora Oxigenante Detox",
          defaultBrand: "Casmara",
          defaultActiveIngredients: "Oxígeno Activo microencapsulado, Extracto de Té Verde",
          defaultActions: "Limpieza profunda de toxinas y oxigenación",
          dosageInstructions: "Aplicar en rostro húmedo, dejar actuar 30 segundos hasta que burbujee, enjuagar.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "oxigenante", "detox", "mist", "bruma"],
          defaultProductName: "Loción Tónica Bruma Anti-Polución",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Extracto de Moringa, Alga Marina",
          defaultActions: "Escudo antipolución y refrescante celular",
          dosageInstructions: "Brumizar a unos 20 cm del rostro y dejar absorber al aire.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "oxigenante", "oxygen", "detox", "antipolución", "energizante"],
          defaultProductName: "Suero Oxigenante Energizante Protector",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Detoxificantes celulares, Oxígeno vectorizado",
          defaultActions: "Estimula la respiración mitocondrial celular",
          dosageInstructions: "Aplicar sobre el rostro, realizando suaves toques ascendentes.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "oxigenante", "detox", "reparadora", "night"],
          defaultProductName: "Crema de Noche Reparadora Oxigenante",
          defaultBrand: "Casmara",
          defaultActiveIngredients: "Extracto de Levadura, Manteca de Karité, Bio-flavonoides",
          defaultActions: "Reparación celular profunda y eliminación de impurezas nocturna",
          dosageInstructions: "Aplicar por la noche sobre cara limpia y cuello con masajes lentos.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "piel sensible": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "sensible", "calmante", "sensitive", "agua micelar", "leche"],
          defaultProductName: "Emulsión Limpiadora Ultra-Calmante",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Agua Termal, Extracto de Avena, Manzanilla",
          defaultActions: "Higiene delicada libre de irritantes",
          dosageInstructions: "Aplicar con las manos o disco de algodón muy suave, retirar sin frotar con agua tibia.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "aquatherm", "calmante", "sensitive", "sensible", "avena"],
          defaultProductName: "Loción Concentrada Térmica Piel Sensible",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Agua Termal, Prebióticos azucarados",
          defaultActions: "Descongestionar y reponer los lípidos de barrera",
          dosageInstructions: "Rociar a distancia o humedecer un algodón y aplicar mediante ligeras presiones.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "sensible", "sensitive", "calmante", "bisabolol", "aloe", "caléndula", "redness", "rojez"],
          defaultProductName: "Serum Desensibilizante Calmante de Caléndula",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Centella Asiática, Alfa-bisabolol, Caléndula",
          defaultActions: "Alivia el enrojecimiento y repara la epidermis sensible",
          dosageInstructions: "Esparcir 3-4 gotas suavemente con la palma de las manos presionando ligeramente.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "sensible", "sensitive", "calmante", "aquatherm", "comfort", "aloe"],
          defaultProductName: "Aquatherm Harmonizing Cream F1",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Agua Termal, Ceramidas, Extracto de Avena",
          defaultActions: "Calma de rojeces, hidratación y reparación de barrera",
          dosageInstructions: "Aplicar en rostro y cuello con masajes alisantes muy ligeros.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "sensible", "mineral", "physical", "sunscreen", "fps"],
          defaultProductName: "Filtro Solar Fluido Mineral Piel Sensible FPS 50+",
          defaultBrand: "General",
          defaultActiveIngredients: "Óxido de Zinc, Dióxido de Titanio (Filtros 100% Minerales)",
          defaultActions: "Máxima protección solar hipoalergénica sin irritar",
          dosageInstructions: "Aplicar uniformemente en rostro y cuello. Ideal para pieles reactivas.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "sensible", "calmante", "sensitive", "agua micelar", "leche"],
          defaultProductName: "Emulsión Limpiadora Ultra-Calmante",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Agua Termal, Extracto de Avena, Manzanilla",
          defaultActions: "Higiene delicada libre de irritantes",
          dosageInstructions: "Aplicar con las manos o disco de algodón muy suave, retirar sin frotar con agua tibia.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "aquatherm", "calmante", "sensitive", "sensible", "avena"],
          defaultProductName: "Loción Concentrada Térmica Piel Sensible",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Agua Termal, Prebióticos azucarados",
          defaultActions: "Descongestionar y reponer los lípidos de barrera",
          dosageInstructions: "Rociar a distancia o humedecer un algodón y aplicar mediante ligeras presiones.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "sensible", "sensitive", "calmante", "bisabolol", "aloe", "caléndula", "redness", "rojez"],
          defaultProductName: "Serum Desensibilizante Calmante de Caléndula",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Centella Asiática, Alfa-bisabolol, Caléndula",
          defaultActions: "Alivia el enrojecimiento y repara la epidermis sensible",
          dosageInstructions: "Esparcir 3-4 gotas suavemente con la palma de las manos presionando ligeramente.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "sensible", "sensitive", "calmante", "nourishing", "reparadora"],
          defaultProductName: "Sense Control Harmonizing Treatment",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Péptidos desensibilizantes, Aloe Vera, Avena",
          defaultActions: "Restauración nocturna, disminuye la rojez cutánea reactiva",
          dosageInstructions: "Aplicar por la noche en todo el rostro con caricias ascendentes suaves.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "hidratacion corporal": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["corporal", "baño", "shower gel", "body wash"],
          defaultProductName: "Gel de Baño Corporal Hidratante",
          defaultBrand: "General",
          defaultActiveIngredients: "Glicerina vegetal, Aloe Vera",
          defaultActions: "Higiene y mantenimiento de humedad corporal",
          dosageInstructions: "Utilizar en la ducha diaria masajeando suavemente sobre el cuerpo y enjuagar.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["corporal", "body", "crema corporal", "hidratación corporal", "hidratante corporal", "urea"],
          defaultProductName: "Crema Corporal de Hidratación Profunda con Urea",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Urea al 10%, Ácido Hialurónico, Aceite de Almendras",
          defaultActions: "Hidratación corporal, emoliencia y suavidad",
          dosageInstructions: "Aplicar después del baño en todo el cuerpo, especialmente en rodillas, codos y talones.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["corporal", "baño", "shower gel", "body wash"],
          defaultProductName: "Gel de Baño Corporal Hidratante",
          defaultBrand: "General",
          defaultActiveIngredients: "Glicerina vegetal, Aloe Vera",
          defaultActions: "Higiene y mantenimiento de humedad corporal",
          dosageInstructions: "Utilizar en la ducha diaria masajeando suavemente sobre el cuerpo y enjuagar.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["corporal", "body", "crema corporal", "hidratación corporal", "hidratante corporal", "urea", "nutritiva"],
          defaultProductName: "Crema Corporal de Hidratación Profunda con Urea",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Urea al 10%, Ácido Hialurónico, Aceite de Almendras",
          defaultActions: "Nutrición corporal, restauración lipídica nocturna",
          dosageInstructions: "Aplicar por la noche sobre la piel limpia corporal mediante masajes circulares.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "nutricion": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "nutritivo", "leche", "cleansing milk", "nourishing", "hidratante"],
          defaultProductName: "Leche Limpiadora de Jalea Real y Nutrientes",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Jalea Real, Manteca de Karité",
          defaultActions: "Higiene lipídica y confort inmediato",
          dosageInstructions: "Masajear sobre el rostro seco y retirar con esponjas humedecidas en agua tibia.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "nutritivo", "nourishing", "mist"],
          defaultProductName: "Loción Tónica Suave Nutritiva",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Extracto de Jalea Real, Alantoína",
          defaultActions: "Preparación de la piel para activos lipídicos",
          dosageInstructions: "Aplicar con gasas o brumizar sobre el rostro.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "nutritivo", "argán", "aceite", "oil", "ampolla", "royal jelly"],
          defaultProductName: "Serum Nutritivo de Jalea Real y Vitaminas",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Jalea Real, Poria Cocos, Vitamina F",
          defaultActions: "Restauración de lípidos esenciales, nutrición intensa",
          dosageInstructions: "Aplicar 4 gotas calentando el producto en las manos y presionar sobre la piel.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "nutritiva", "nourishing", "comfort", "royal jelly", "jalea real"],
          defaultProductName: "Royal Jelly Comforting Emulsion",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Jalea Real, Extracto de Poria Cocos, Pantenol",
          defaultActions: "Aporta nutrientes, elasticidad y protección",
          dosageInstructions: "Masajear suavemente en rostro y cuello hasta absorber.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "sunscreen", "fps", "rich", "crema"],
          defaultProductName: "Protector Solar Crema Nutritiva FPS 50+",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Filtros solares, Coenzima Q10",
          defaultActions: "Protección UV y nutrición antioxidante",
          dosageInstructions: "Aplicar uniformemente en rostro y cuello como último paso matutino.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "nutritivo", "leche", "cleansing milk", "nourishing", "hidratante"],
          defaultProductName: "Leche Limpiadora de Jalea Real y Nutrientes",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Jalea Real, Manteca de Karité",
          defaultActions: "Higiene lipídica y confort inmediato",
          dosageInstructions: "Masajear sobre el rostro seco y retirar con esponjas humedecidas en agua tibia.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "nutritivo", "nourishing", "mist"],
          defaultProductName: "Loción Tónica Suave Nutritiva",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Extracto de Jalea Real, Alantoína",
          defaultActions: "Preparación de la piel para activos lipídicos",
          dosageInstructions: "Aplicar con gasas o brumizar sobre el rostro.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "nutritivo", "argán", "aceite", "oil", "ampolla", "royal jelly"],
          defaultProductName: "Serum Nutritivo de Jalea Real y Vitaminas",
          defaultBrand: "Germaine de Capuccini",
          defaultActiveIngredients: "Jalea Real, Poria Cocos, Vitamina F",
          defaultActions: "Restauración de lípidos esenciales, nutrición intensa",
          dosageInstructions: "Aplicar 4 gotas calentando el product en las manos y presionar sobre la piel.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "nutritiva", "nourishing", "repair", "karité", "argán"],
          defaultProductName: "Crema Súper Nutritiva Reparadora de Noche",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Aceite de Argán, Manteca de Karité, Ácido Hialurónico",
          defaultActions: "Recuperación lipídica nocturna y nutrición regeneradora",
          dosageInstructions: "Aplicar generosamente en rostro y cuello masajeando de manera relajante.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    },
    "anti acne": {
      Dia: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "grasa", "sebo", "salicílico", "purificante", "acné", "seboregulator"],
          defaultProductName: "Gel Limpiador Anti-Acné Ácido Salicílico",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Salicílico, Zinc",
          defaultActions: "Higiene profunda bactericida y seborreguladora",
          dosageInstructions: "Aplicar en rostro húmedo, masajear en zonas propensas a brotes y aclarar con abundante agua.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "balance", "grasa", "sebo", "astringente", "salicílico", "acné"],
          defaultProductName: "Loción Aclarante Anti-Acné",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Ácido Salicílico, Extracto de Hamamelis",
          defaultActions: "Desinfectante, astringente y calmante de brotes",
          dosageInstructions: "Aplicar con un disco de algodón de manera localizada en las zonas acneicas.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "acné", "acne", "salicílico", "niacinamida", "zinc", "purificante"],
          defaultProductName: "Serum Regulador Anti-Acné Focal",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Ácido Salicílico al 2%, Niacinamida",
          defaultActions: "Desinflamación de pápulas y control de la queratinización",
          dosageInstructions: "Aplicar una gota directo en el brote o una fina película en áreas de comedones.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Crema de Día",
          keywords: ["crema", "gel", "grasa", "acné", "purificante", "seborreguladora", "oil-free"],
          defaultProductName: "Gel Crema Matificante Hidratante Anti-Acné",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Zinc PCA, Ácido Salicílico",
          defaultActions: "Aporta hidratación libre de grasa y disminuye la rojez del acné",
          dosageInstructions: "Extender una pequeña cantidad con las manos bien limpias.",
          applicationFrequency: "Diario por la mañana"
        },
        {
          stepName: "Protección Solar",
          keywords: ["protección", "solar", "grasa", "oil-free", "toque seco", "dry touch", "mate"],
          defaultProductName: "Filtro Solar Toque Seco Mate FPS 50+",
          defaultBrand: "Skeyndor",
          defaultActiveIngredients: "Filtros solares, Polvos matificantes",
          defaultActions: "Protección UV sin ocluir poros ni aportar oleosidad",
          dosageInstructions: "Aplicar sobre el rostro seco antes de exponerse al sol. Reaplicar regularmente.",
          applicationFrequency: "Diario por la mañana"
        }
      ],
      Noche: [
        {
          stepName: "Limpieza",
          keywords: ["limpiador", "grasa", "sebo", "salicílico", "purificante", "acné", "seboregulator"],
          defaultProductName: "Gel Limpiador Anti-Acné Ácido Salicílico",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Salicílico, Zinc",
          defaultActions: "Higiene profunda bactericida y seborreguladora",
          dosageInstructions: "Aplicar en rostro húmedo, masajear en zonas propensas a brotes y aclarar con abundante agua.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Tonificación",
          keywords: ["loción", "tónico", "balance", "grasa", "sebo", "astringente", "salicílico", "acné"],
          defaultProductName: "Loción Aclarante Anti-Acné",
          defaultBrand: "Miguett",
          defaultActiveIngredients: "Ácido Salicílico, Extracto de Hamamelis",
          defaultActions: "Desinfectante, astringente y calmante de brotes",
          dosageInstructions: "Aplicar con un disco de algodón de manera localizada en las zonas acneicas.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Suero / Activo",
          keywords: ["serum", "acné", "acne", "salicílico", "niacinamida", "zinc", "purificante", "glycolic", "mandélico"],
          defaultProductName: "Concentrado Renovador Anti-Acné de Noche",
          defaultBrand: "Mesoestetic",
          defaultActiveIngredients: "Ácido Mandélico, Ácido Salicílico, Tea Tree Oil",
          defaultActions: "Renovador celular de poros obstruidos, secante y sebostático",
          dosageInstructions: "Aplicar por la noche sobre la piel limpia y seca. Sensación de hormigueo normal al inicio.",
          applicationFrequency: "Diario por la noche"
        },
        {
          stepName: "Crema de Noche",
          keywords: ["crema", "noche", "gel", "grasa", "acné", "purificante", "seborreguladora", "renovadora"],
          defaultProductName: "Gel Crema Seborregulador Intensivo Nocturno",
          defaultBrand: "Lidherma",
          defaultActiveIngredients: "Retinol Liposomado, Ácido Salicílico, Zinc PCA",
          defaultActions: "Regeneración nocturna y control bacteriano profundo contra el acné",
          dosageInstructions: "Aplicar una fina capa antes de dormir en las áreas afectadas.",
          applicationFrequency: "Diario por la noche"
        }
      ]
    }
  };

  const getMatchingProductsForStep = useCallback((step: RoutineStepTemplate): Product[] => {
    return products.filter(p => {
      const nameLower = p.name.toLowerCase();
      const brandLower = p.brandLine.toLowerCase();
      
      let activeIngredientsArray: string[] = [];
      try {
        activeIngredientsArray = JSON.parse(p.activeIngredients || '[]');
      } catch(e) {
        if (p.activeIngredients) {
          activeIngredientsArray = [p.activeIngredients];
        }
      }
      
      return step.keywords.some((keyword: string) => {
        const kw = keyword.toLowerCase();
        if (nameLower.includes(kw)) return true;
        if (brandLower.includes(kw)) return true;
        if (activeIngredientsArray.some(act => act.toLowerCase().includes(kw))) return true;
        return false;
      });
    });
  }, [products]);

  const handleAddStepToCurrentRoutine = () => {
    setEditableRoutineSteps(prev => [
      ...prev,
      {
        stepName: 'Nueva Fase / Sección',
        keywords: ['suero', 'limpiador', 'crema'],
        defaultProductName: 'Producto del Catálogo',
        defaultBrand: 'Línea Clínica',
        defaultActiveIngredients: 'Por definir',
        defaultActions: 'Acción cosmetológica',
        dosageInstructions: 'Aplicar suavemente sobre el rostro.',
        applicationFrequency: selectedRoutineTime === 'Dia' ? 'Diario por la mañana' : 'Diario por la noche'
      }
    ]);
  };

  const handleUpdateStepInRoutine = (index: number, field: keyof RoutineStepTemplate, value: string) => {
    setEditableRoutineSteps(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleRemoveStepFromCurrentRoutine = (index: number) => {
    setEditableRoutineSteps(prev => prev.filter((_, i) => i !== index));
  };

  const applySelectedRoutineToPatient = () => {
    if (!selectedPatientId) {
      showToastMsg('Por favor seleccione o cree un paciente primero.', 'error');
      return;
    }
    
    const steps = editableRoutineSteps.length > 0 
      ? editableRoutineSteps 
      : (ESTABLISHED_ROUTINES[selectedRoutineTx] ? (selectedRoutineTime === 'Dia' ? ESTABLISHED_ROUTINES[selectedRoutineTx].Dia : ESTABLISHED_ROUTINES[selectedRoutineTx].Noche) : []);

    if (steps.length === 0) return;
    
    const newPrescriptions: Prescription[] = steps.map((step, index) => {
      const selectionKey = `${selectedRoutineTx}_${selectedRoutineTime}_${index}`;
      const selectedValue = routineStepSelections[selectionKey] || 'default';
      
      let targetProduct: Product | undefined = undefined;

      if (selectedValue !== 'default') {
        targetProduct = products.find(p => p.id === selectedValue);
      } else {
        const matches = getMatchingProductsForStep(step);
        if (matches.length > 0) {
          targetProduct = matches[0];
        }
      }

      let pId: string | undefined = targetProduct?.id;
      let pName = targetProduct ? targetProduct.name : step.defaultProductName;
      let pBrand = targetProduct ? targetProduct.brandLine : step.defaultBrand;
      let pActives = step.defaultActiveIngredients;
      let pActions = step.defaultActions;

      if (targetProduct) {
        try {
          const parsed = JSON.parse(targetProduct.activeIngredients || '[]');
          pActives = Array.isArray(parsed) ? parsed.join(', ') : targetProduct.activeIngredients;
        } catch(e) {
          pActives = targetProduct.activeIngredients;
        }

        try {
          const parsed = JSON.parse(targetProduct.physiologicalActions || '[]');
          pActions = Array.isArray(parsed) ? parsed.join(', ') : targetProduct.physiologicalActions;
        } catch(e) {
          pActions = targetProduct.physiologicalActions;
        }
      }

      return {
        id: Math.random().toString(36).substring(2, 9).toUpperCase(),
        consultationId: patientForm.id || 'TEMP',
        productId: pId,
        timeOfDay: selectedRoutineTime === 'Dia' ? 'Dia' : 'Noche',
        dosageInstructions: step.dosageInstructions,
        applicationFrequency: step.applicationFrequency,
        stepName: step.stepName,
        customProductName: pName,
        customBrand: pBrand,
        customActiveIngredients: pActives,
        customActions: pActions,
        productDetails: targetProduct
      };
    });

    setPrescriptionsList(prev => [...prev, ...newPrescriptions]);
    showToastMsg(`Rutina ${selectedRoutineTx} (${selectedRoutineTime === 'Dia' ? 'Día' : 'Noche'}) vinculada del catálogo y agregada al protocolo.`, 'success');
  };
  const handleSaveCurrentProtocolAsPreset = () => {
    if (prescriptionsList.length === 0) {
      showToastMsg('No hay productos en el protocolo de apoyo actual para guardar.', 'error');
      return;
    }
    setNewRoutineName('');
    setShowSaveRoutineModal(true);
  };

  const handleConfirmSaveRoutine = () => {
    const trimmedName = newRoutineName.trim();
    if (!trimmedName) {
      showToastMsg('Por favor ingrese un nombre para la rutina.', 'error');
      return;
    }

    if (customRoutines.some(r => r.name.toLowerCase() === trimmedName.toLowerCase())) {
      showToastMsg('Ya existe una rutina con ese nombre.', 'error');
      return;
    }

    const newRoutine: CustomRoutine = {
      name: trimmedName,
      prescriptions: prescriptionsList.map(p => ({
        productId: p.productId,
        timeOfDay: p.timeOfDay,
        dosageInstructions: p.dosageInstructions,
        applicationFrequency: p.applicationFrequency,
        stepName: p.stepName,
        customProductName: p.customProductName,
        customBrand: p.customBrand,
        customActiveIngredients: p.customActiveIngredients,
        customActions: p.customActions,
        productDetails: p.productDetails
      }))
    };

    const updated = [...customRoutines, newRoutine];
    setCustomRoutines(updated);
    localStorage.setItem('dermatique_custom_routines', JSON.stringify(updated));
    setShowSaveRoutineModal(false);
    showToastMsg(`Rutina "${trimmedName}" guardada como predeterminada.`, 'success');
  };

  const handleDeleteCustomRoutine = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = customRoutines.filter(r => r.name !== name);
    setCustomRoutines(updated);
    localStorage.setItem('dermatique_custom_routines', JSON.stringify(updated));
    
    if (selectedCustomRoutine?.name === name) {
      setSelectedCustomRoutine(null);
    }
    showToastMsg(`Rutina "${name}" eliminada.`, 'success');
  };

  const applyCustomRoutineToPatient = () => {
    if (!selectedPatientId) {
      showToastMsg('Por favor seleccione o cree un paciente primero.', 'error');
      return;
    }
    if (!selectedCustomRoutine) return;

    const newPrescriptions: Prescription[] = selectedCustomRoutine.prescriptions.map(p => ({
      id: Math.random().toString(36).substring(2, 9).toUpperCase(),
      consultationId: patientForm.id || 'TEMP',
      productId: p.productId,
      timeOfDay: p.timeOfDay,
      dosageInstructions: p.dosageInstructions,
      applicationFrequency: p.applicationFrequency,
      stepName: p.stepName,
      customProductName: p.customProductName,
      customBrand: p.customBrand,
      customActiveIngredients: p.customActiveIngredients,
      customActions: p.customActions,
      productDetails: p.productDetails
    }));

    setPrescriptionsList(prev => [...prev, ...newPrescriptions]);
    showToastMsg(`Rutina "${selectedCustomRoutine.name}" cargada al protocolo de apoyo.`, 'success');
  };


  // ----------------------------------------------------
  // EXCEL BULK INGEST (PapaParse / SheetJS)
  // ----------------------------------------------------
  const handlePdfUpload = async (file: File) => {
    showToastMsg('Procesando archivo PDF...', 'success');
    try {
      const pdfjsLib = await new Promise<any>((resolve, reject) => {
        if ((window as any).pdfjsLib) {
          resolve((window as any).pdfjsLib);
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
        script.onload = () => {
          const pdfjs = (window as any).pdfjsLib;
          pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
          resolve(pdfjs);
        };
        script.onerror = () => reject(new Error('Fallo al cargar extractor PDF.'));
        document.head.appendChild(script);
      });

      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let text = '';
      
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        text += pageText + '\n';
      }

      const lines = text.split('\n');
      const parsedProducts: Product[] = [];
      let index = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        const skuMatch = line.match(/(SKU-[A-Z0-9-]+|[A-Z]{3,4}-\d{3,5})/i);
        const priceMatch = line.match(/(\d{3,5}(\.\d{2})?)/);
        
        if (line.length > 5 && (skuMatch || line.toLowerCase().includes('sku') || line.includes('$') || /germaine|lidherma|skeyndor|miguett|casmara/i.test(line))) {
          const sku = skuMatch ? skuMatch[0] : `SKU-PDF-${index}`;
          const price = priceMatch ? parseFloat(priceMatch[0]) : 500;
          const brandMatch = line.match(/germaine|germaine de capuccini|lidherma|skeyndor|miguett|casmara/i);
          const brand = brandMatch ? brandMatch[0] : 'Genérico';
          
          let cleanedName = line
            .replace(/(SKU-[A-Z0-9-]+|[A-Z]{3,4}-\d{3,5})/ig, '')
            .replace(/[\$\d\.,\-\:]+/g, '')
            .replace(/germaine de capuccini|lidherma|skeyndor|miguett|casmara/ig, '')
            .trim();
          
          if (!cleanedName) cleanedName = `Producto PDF ${index + 1}`;

          parsedProducts.push({
            id: `PDF-${index}-${Math.floor(Math.random() * 1000)}`,
            sku,
            name: cleanedName,
            brandLine: brand,
            retailPrice: price,
            isProfessionalUse: true,
            activeIngredients: JSON.stringify([]),
            physiologicalActions: JSON.stringify([]),
            skinBiotypes: '[]'
          });
          index++;
        }
      }

      if (parsedProducts.length === 0) {
        showToastMsg('El PDF no tiene formato tabular reconocible. Extrayendo líneas clave...', 'error');
        const shortLines = lines.filter(l => l.trim().length > 10 && l.trim().length < 80).slice(0, 10);
        shortLines.forEach((l, idx) => {
          parsedProducts.push({
            id: `PDF-KEY-${idx}-${Math.floor(Math.random() * 1000)}`,
            sku: `SKU-PDF-${idx}`,
            name: l.trim(),
            brandLine: 'Genérico',
            retailPrice: 450,
            isProfessionalUse: true,
            activeIngredients: JSON.stringify([]),
            physiologicalActions: JSON.stringify([]),
            skinBiotypes: '[]'
          });
        });
      }

      applyUploadPreview(parsedProducts);
      showToastMsg(`Previsualizando ${parsedProducts.length} productos extraídos del PDF. Revisa y corrige cada fila antes de confirmar — el reconocimiento automático de PDF varía según el diseño de catálogo de cada marca.`, 'success');
    } catch (e: any) {
      console.error(e);
      showToastMsg(e.message || 'Error al procesar el archivo PDF.', 'error');
    }
  };

  // Carga la vista previa y pre-marca como excluidas (pero editable/reincluible) las filas cuyo
  // nombre+marca ya exista en el catálogo actual, para poder reimportar el mismo archivo sin
  // duplicar todo cada vez.
  const applyUploadPreview = (mapped: Product[]) => {
    const excluded: Record<string, boolean> = {};
    mapped.forEach(p => {
      if (isDuplicateProduct(p, products)) excluded[p.id] = true;
    });
    setUploadPreviewExcludedIds(excluded);
    setUploadPreview(mapped);
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      handlePdfUpload(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = new Uint8Array(evt.target?.result as ArrayBuffer);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet) as any[];

      // Reconoce tanto los encabezados genéricos originales (SKU, Nombre, Marca, Precio...) como
      // los de catálogos reales de proveedor (ID / Clave, Nombre del Producto, Categoría, Precio
      // Esteticista/Público (MXN), Activos Clave, Biotipo / Indicación) — p. ej. el catálogo de
      // Resourses/Catalogo_Productos_Corregido.xlsx usa este segundo formato.
      const mapped: Product[] = json.map((row, idx) => {
        const rawName = row.Nombre || row['Nombre del Producto'] || row.Producto || 'Insumo importado';
        const capacity = row.Capacidad ? String(row.Capacidad).trim() : '';
        const name = capacity && !String(rawName).toLowerCase().includes(capacity.toLowerCase())
          ? `${String(rawName).trim()} (${capacity})`
          : String(rawName).trim();
        const brandLine = String(row.Marca || 'Genérico').trim();
        const sku = String(row.SKU || row['ID / Clave'] || row['ID/Clave'] || `SKU-${idx}`).trim();
        const productType = row.Categoría || row.Categoria;

        const publicPriceRaw = row['Precio Público (MXN)'] ?? row['Precio Publico (MXN)'];
        const hasPublicPrice = publicPriceRaw !== undefined && String(publicPriceRaw).trim() !== '' && String(publicPriceRaw).trim().toUpperCase() !== 'N/A';
        const retailPrice = parseMoneyValue(row['Precio Esteticista (MXN)'] ?? row.Precio);

        let isProfessionalUse: number;
        if (row.UsoProfesional !== undefined) {
          isProfessionalUse = row.UsoProfesional === 'Ambos' || row.UsoProfesional === 2 || String(row.UsoProfesional).toLowerCase().includes('ambos') ? 2 : (row.UsoProfesional === 'Sí' || row.UsoProfesional === 1 || String(row.UsoProfesional).toLowerCase().includes('cabina') || String(row.UsoProfesional).toLowerCase().includes('sí') ? 1 : 0);
        } else {
          // Sin columna explícita de uso: si tiene precio público real, se asume venta en cabina
          // y en casa (2); si el precio público es "N/A"/vacío, se asume solo uso profesional (1).
          isProfessionalUse = hasPublicPrice ? 2 : 1;
        }

        const activesRaw = row.Activos || row['Activos Clave'];
        const actionsRaw = row.Acciones;
        const biotypesRaw = row.Biotipos || row['Biotipo / Indicación'] || row['Biotipo / Indicacion'];
        const splitList = (raw: any) => raw ? String(raw).split(',').map((s: string) => s.trim()).filter(Boolean) : [];

        return {
          id: `EXCEL-${idx}-${Math.floor(Math.random() * 1000)}`,
          sku,
          name,
          brandLine,
          productType: productType ? String(productType).trim() : undefined,
          retailPrice,
          isProfessionalUse,
          activeIngredients: JSON.stringify(splitList(activesRaw)),
          physiologicalActions: JSON.stringify(splitList(actionsRaw)),
          skinBiotypes: JSON.stringify(splitList(biotypesRaw))
        };
      });

      applyUploadPreview(mapped);
      const dupCount = mapped.filter(p => isDuplicateProduct(p, products)).length;
      showToastMsg(`Previsualizando ${mapped.length} productos del archivo${dupCount > 0 ? ` (${dupCount} ya existen y se excluyeron por defecto)` : ''}.`, 'success');
    };
    reader.readAsArrayBuffer(file);
  };

  const updateUploadPreviewRow = (id: string, patch: Partial<Product>) => {
    setUploadPreview(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  };

  const toggleUploadPreviewExclusion = (id: string) => {
    setUploadPreviewExcludedIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const confirmBulkImport = async () => {
    const toImport = uploadPreview.filter(p => !uploadPreviewExcludedIds[p.id]);
    if (toImport.length === 0) return;
    try {
      await saveProducts(toImport);
      showToastMsg(`${toImport.length} productos importados y sincronizados con éxito.`, 'success');
      setUploadPreview([]);
      setUploadPreviewExcludedIds({});
      loadMasterCatalogs();
    } catch(err) {
      console.error(err);
      showToastMsg('Error al importar catálogo masivamente.', 'error');
    }
  };

  // ----------------------------------------------------
  // RENDER STATION
  // ----------------------------------------------------
  // LICENSE KEY & ACCESS CONTROL OVERLAY (CLOUDFLARE WORKERS INTEGRATED)
  // ----------------------------------------------------
  if (!isLogged) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-4 animate-fade-in backdrop-blur-md overflow-y-auto">
        <div className="w-full max-w-md p-8 rounded-[32px] bg-slate-900 border border-amber-500/30 shadow-2xl flex flex-col justify-center gap-6 relative my-auto">
          <div className="text-center flex flex-col items-center gap-2">
            <img src="https://raw.githubusercontent.com/carlosgbd94-design/Logos/refs/heads/main/logo_xarixuri_cosmetolog_a-removebg-preview.png" alt="Xarixuri Cosmetología" className="h-16 w-auto object-contain dark:brightness-110 mb-1" />
            <h2 className="font-outfit text-xl font-bold text-white">Estación Médica Estética</h2>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 text-amber-400 text-[10px] font-bold uppercase tracking-wider">
              <Lock className="w-3 h-3" /> Control de Licencia de Dispositivo
            </div>
          </div>

          <form onSubmit={handleLicenseSubmit} className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">Clave de Licencia Profesional</label>
              <input
                type="text"
                value={licenseKeyInput}
                onChange={e => setLicenseKeyInput(e.target.value.toUpperCase())}
                placeholder="Ej: DERM-892A-4F91-XXXX"
                required
                className="smart-input w-full px-4 py-3 rounded-xl text-sm font-mono tracking-wider text-center uppercase"
              />
            </div>

            {loginError && (
              <div className="text-xs text-red-400 font-semibold text-center bg-red-500/10 p-2.5 rounded-xl border border-red-500/20">{loginError}</div>
            )}

            <button type="submit" disabled={loginLoading} className="w-full bg-gradient-to-r from-amber-500 to-bronze-600 hover:brightness-110 text-white py-3.5 rounded-xl text-xs font-bold shadow-lg transition-all flex items-center justify-center gap-2">
              <Key className="w-4 h-4" />
              <span>{loginLoading ? 'Validando Licencia...' : 'Activar y Entrar a la Estación'}</span>
            </button>
          </form>

          <div className="border-t border-white/10 pt-4 text-center space-y-3 w-full" style={{ writingMode: 'horizontal-tb' }}>
            <p className="text-xs font-bold text-slate-200">Adquirir Licencia Profesional vía PayPal:</p>
            <div id="paypal-container-E8TGNWX7MLLJE" className="w-full min-h-[60px] flex justify-center items-center overflow-visible" style={{ minWidth: '280px', writingMode: 'horizontal-tb' }}></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen bg-[#FAF9F6] dark:bg-[#0A0A0D] text-slate-700 dark:text-luxe-100 pb-16 antialiased ${isTouchDevice ? 'touch-device' : ''}`}>
      {/* Sync / Toast Notifications */}
      {toast.visible && (
        <div className={`fixed top-5 right-5 z-50 flex items-start gap-3 px-5 py-3.5 rounded-2xl shadow-2xl max-w-md border-l-4 ${
          toast.type === 'success' ? 'border-emerald-400' : toast.type === 'info' ? 'border-amber-400' : 'border-red-400'
        } border-y border-r border-slate-200/50 dark:border-white/10 text-slate-800 dark:text-white bg-white/90 dark:bg-luxe-800/90 backdrop-blur-md animate-toast-in`}>
          {toast.type === 'success' ? <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" /> : toast.type === 'info' ? <Info className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" /> : <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />}
          <p className="text-sm font-medium tracking-wide flex-1">{toast.message}</p>
          <button
            type="button"
            onClick={() => setToast(prev => ({ ...prev, visible: false }))}
            className="shrink-0 text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors -mt-0.5"
            aria-label="Cerrar notificación"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Navigation Header */}
      <nav className="w-full border-b border-slate-200/50 dark:border-white/5 bg-white/95 dark:bg-luxe-900/95 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 sm:px-6 flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="flex items-center justify-between w-full md:w-auto gap-3">
            <div className="flex items-center gap-3">
              <img src="https://raw.githubusercontent.com/carlosgbd94-design/Logos/refs/heads/main/logo_xarixuri_cosmetolog_a-removebg-preview.png" alt="Xarixuri" className="h-10 md:h-12 w-auto object-contain dark:brightness-110" />
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ml-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>{syncStatus === 'online' ? 'En línea' : syncStatus === 'syncing' ? 'Sincronizando...' : 'Local'}</span>
              </div>
              {licenseDevices && (
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase border border-slate-200/50 dark:border-white/10 bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-luxe-300"
                  title={`Esta licencia está activada en ${licenseDevices.used} de ${licenseDevices.max} dispositivos permitidos.`}
                >
                  <Key className="w-3 h-3 text-amber-500" />
                  <span>{licenseDevices.used}/{licenseDevices.max}</span>
                </div>
              )}
            </div>
            
            <div className="flex items-center gap-2 md:hidden">
              <button onClick={toggleTheme} className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-700 dark:text-luxe-300 flex items-center justify-center"><Sun className="w-4.5 h-4.5" /></button>
              <button onClick={handleLogout} className="w-10 h-10 rounded-xl bg-red-100/50 dark:bg-red-500/10 text-red-600 flex items-center justify-center"><Lock className="w-4.5 h-4.5" /></button>
            </div>
          </div>

          <div className="flex w-full md:w-auto bg-slate-100 dark:bg-white/5 border border-slate-200/30 dark:border-white/5 p-1 rounded-2xl">
            {(['generator', 'inventory', 'records'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`flex-1 md:flex-none px-5 py-2 rounded-xl text-xs font-semibold transition-all ${activeTab === tab ? 'bg-white text-slate-800 dark:bg-white/10 dark:text-white shadow-sm' : 'text-slate-500 dark:text-luxe-300'}`}>
                {tab === 'generator' ? 'Generador de Fichas' : tab === 'inventory' ? 'Gestión de Catálogo' : 'Expedientes Clínicos'}
              </button>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-2">
            <button
              onClick={() => setIsBackupModalOpen(true)}
              className="px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-700 dark:text-luxe-300 hover:text-amber-500 flex items-center gap-1.5 text-xs font-bold transition-all border border-slate-200/50 dark:border-white/5 shadow-sm"
              title="Centro de Respaldo y Copias de Seguridad de la Base de Datos"
            >
              <Database className="w-4 h-4 text-amber-500" />
              <span className="hidden lg:inline">Respaldo BD</span>
            </button>

            <button
              onClick={() => setIsTrashModalOpen(true)}
              className="relative px-3.5 py-2 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-700 dark:text-luxe-300 hover:text-amber-500 flex items-center gap-1.5 text-xs font-bold transition-all border border-slate-200/50 dark:border-white/5 shadow-sm"
              title="Papelera de pacientes y visitas eliminados"
            >
              <Trash2 className="w-4 h-4 text-amber-500" />
              <span className="hidden lg:inline">Papelera</span>
              {(deletedPatients.length + deletedConsultationsWithNames.length) > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {deletedPatients.length + deletedConsultationsWithNames.length}
                </span>
              )}
            </button>

            <button onClick={toggleTheme} className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-700 dark:text-luxe-300 flex items-center justify-center">{theme === 'light' ? <Moon className="w-4.5 h-4.5" /> : <Sun className="w-4.5 h-4.5" />}</button>
            <button onClick={handleLogout} className="w-10 h-10 rounded-xl bg-red-100/50 dark:bg-red-500/10 text-red-600 flex items-center justify-center"><Lock className="w-4.5 h-4.5" /></button>
          </div>
        </div>
      </nav>

      {/* Main Workspace */}
      <main className="max-w-7xl mx-auto px-6 mt-8">
        
        {/* TAB 1: GENERADOR CLINICO */}
        {activeTab === 'generator' && (
          <div className={`space-y-8 ${activeConsultationId ? 'pb-24' : ''}`}>
            <div className="liquid-glass rounded-[32px] p-8 md:p-10 relative overflow-hidden">
              <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-bronze-500/10 blur-[100px] pointer-events-none" />

              <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-5 mb-8 pb-6 border-b border-slate-200/50 dark:border-white/5">
                <div>
                  <h1 className="font-outfit text-2xl font-bold text-slate-800 dark:text-white">Ficha de Diagnóstico Estético</h1>
                  <p className="text-slate-500 dark:text-luxe-300 text-xs mt-1">Valoración cutánea y recomendación cosmética profesional</p>
                  {draftSavedAt && (
                    <div className="flex items-center gap-2 mt-2 animate-fade-in">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                      <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 tracking-wide">
                        Borrador guardado localmente · {new Date(draftSavedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <button
                        type="button"
                        onClick={() => resetPatientForm()}
                        className="text-[10px] font-semibold text-slate-400 hover:text-red-500 underline decoration-dotted transition-colors"
                      >
                        Descartar
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-start md:items-end gap-2 w-full md:w-auto">
                  {/* Clinical Workflow Phases Controller: en escritorio son píldoras compactas alineadas
                      a la derecha; en táctil se apilan a ancho completo, sin scroll oculto, y cada botón
                      crece a un tamaño de toque real (min 44px de alto) en vez de comprimirse hasta cortar texto. */}
                  <div className="flex flex-col items-start md:items-end w-full md:w-auto">
                    <span className="text-[9px] font-extrabold uppercase text-slate-400 dark:text-luxe-400 tracking-widest mb-1">Fase del Proceso Clínico</span>
                    <div className={isTouchDevice
                      ? 'grid grid-cols-2 sm:grid-cols-3 gap-1.5 bg-slate-100 dark:bg-white/5 p-1.5 rounded-2xl border border-slate-200/50 dark:border-white/5 relative group w-full'
                      : 'flex flex-wrap gap-1.5 bg-slate-100 dark:bg-white/5 p-1.5 rounded-2xl border border-slate-200/50 dark:border-white/5 relative group w-full md:w-auto'
                    }>
                      {(['Borrador', 'Admision', 'Consentimiento', 'Tratamiento', 'Evaluacion'] as ConsultationState[]).map(st => {
                        const descriptions: Record<ConsultationState, string> = {
                          Borrador: 'Borrador inicial / Notas preliminares de cabina',
                          Admision: 'Ficha biográfica, motivos de consulta y anamnesis médica',
                          Consentimiento: 'Consentimiento legal firmado e identificación oficial del paciente',
                          Tratamiento: 'Protocolo de tratamiento en cabina y activos aplicados',
                          Evaluacion: 'Resultados clínicos obtenidos, apoyo domiciliario y recomendaciones'
                        };
                        const labels: Record<ConsultationState, string> = {
                          Borrador: 'Borrador',
                          Admision: 'Admisión',
                          Consentimiento: 'Consentimiento',
                          Tratamiento: 'Tratamiento',
                          Evaluacion: 'Evaluación'
                        };
                        return (
                          <button
                            key={st}
                            type="button"
                            onClick={() => updateState(st)}
                            title={descriptions[st]}
                            className={`rounded-xl font-bold tracking-wider uppercase transition-all relative ${
                              isTouchDevice ? 'px-3 py-3 text-[11px] min-h-[44px]' : 'flex-1 md:flex-none px-3 py-1.5 text-[10px]'
                            } ${
                              patientForm.state === st
                                ? 'bg-gradient-to-r from-bronze-500 to-bronze-600 text-white shadow-md'
                                : 'text-slate-500 dark:text-luxe-300 hover:bg-slate-200/50 dark:hover:bg-white/5'
                            }`}
                          >
                            {labels[st]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {activeConsultationId && (
                <div className="bg-gradient-to-r from-amber-500/10 via-amber-600/10 to-amber-700/10 border border-amber-500/30 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in mb-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded-xl">
                      <Sparkles className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-outfit text-sm font-bold text-slate-800 dark:text-white">Modo Edición Activo</h4>
                      <p className="text-[11px] text-slate-500 dark:text-luxe-300">
                        Estás modificando la sesión de <strong>{`${patientForm.firstName} ${patientForm.lastName}`.trim() || 'este paciente'}</strong> <span className="font-mono">({activeConsultationId})</span>. Los cambios reemplazarán el registro anterior al guardar.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveConsultationId('');
                      resetPatientForm();
                      showToastMsg('Iniciando nueva consulta de expediente.', 'success');
                    }}
                    className="px-4 py-2 bg-white dark:bg-luxe-950/20 border border-slate-200/50 dark:border-white/5 rounded-xl text-xs font-bold text-slate-700 dark:text-luxe-200 hover:bg-slate-100 dark:hover:bg-white/5 transition-all shadow-sm flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" /> Nueva Consulta / Limpiar
                  </button>
                </div>
              )}
              <form id="ficha-consulta-form" onSubmit={handleSaveConsultation} className="space-y-6">
                {/* Seguimiento de Pacientes */}
                <div className="bg-slate-50/50 dark:bg-white/5 p-5 rounded-2xl border border-slate-200/50 dark:border-white/5 space-y-4">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex flex-col gap-1">
                      <span className="font-outfit text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider">Seguimiento de Pacientes</span>
                      <p className="text-[11px] text-slate-500 dark:text-luxe-400">Busca y selecciona un paciente existente para no duplicar datos y cargar su historial clínico.</p>
                    </div>
                    <div className="w-full md:w-80">
                      <select
                        value={selectedPatientId}
                        onChange={e => handleSelectPatient(e.target.value)}
                        className="smart-input w-full px-4 py-2.5 rounded-xl text-xs bg-no-repeat bg-[right_1rem_center]"
                      >
                        <option value="">-- Registrar Nuevo Paciente --</option>
                        {patients.filter(p => !p.deletedAt).sort((a,b) => a.firstNameEncrypted.localeCompare(b.firstNameEncrypted)).map(p => (
                          <option key={p.id} value={p.id}>
                            {`${p.firstNameEncrypted} ${p.lastNameEncrypted} (${p.phoneEncrypted})`}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* List of Previous Sessions for this Patient */}
                  {selectedPatientId && (() => {
                    const patientConsultations = records.filter(r => r.patientId === selectedPatientId);
                    if (patientConsultations.length > 0) {
                      return (
                        <div className="pt-3 border-t border-slate-200/50 dark:border-white/5">
                          <h4 className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest mb-2">Expedientes previos en sistema ({patientConsultations.length}):</h4>
                          <div className="flex flex-wrap gap-2">
                            {patientConsultations.map(pc => (
                              <div key={pc.id} className="flex items-center gap-2 bg-white/60 dark:bg-luxe-950/40 border border-slate-200/50 dark:border-white/5 px-3 py-1.5 rounded-lg text-xs">
                                <span className="font-semibold">{new Date(pc.visitDate).toLocaleDateString()}</span>
                                <span className="text-[10px] bg-amber-500/15 text-amber-500 px-1.5 py-0.5 rounded font-bold uppercase">{pc.state}</span>
                                <span className="text-slate-400">| {pc.skinBiotype}</span>
                                <button
                                  type="button"
                                  onClick={() => handleLoadPreviousConsultationBaseline(pc)}
                                  className="text-blue-500 hover:text-blue-600 font-bold ml-1 text-[10px]"
                                  title="Cargar esta sesión como base"
                                >
                                  Cargar sesión
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>

                {/* Paciente */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Primer Nombre</label>
                    <input type="text" value={patientForm.firstName} onChange={e => setPatientForm(prev => ({ ...prev, firstName: e.target.value }))} required placeholder="Nombre..." className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Apellidos</label>
                    <input type="text" value={patientForm.lastName} onChange={e => setPatientForm(prev => ({ ...prev, lastName: e.target.value }))} required placeholder="Apellidos..." className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Fecha de Nacimiento</label>
                    <input type="date" value={patientForm.dateOfBirth} onChange={e => setPatientForm(prev => ({ ...prev, dateOfBirth: e.target.value }))} className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Teléfono</label>
                    <input type="text" value={patientForm.phone} onChange={e => setPatientForm(prev => ({ ...prev, phone: e.target.value }))} required placeholder="Teléfono..." className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                </div>

                {/* Aviso de posible paciente duplicado: solo al registrar uno nuevo (no cuando ya
                    se seleccionó uno existente arriba), comparando teléfono o nombre+apellido
                    contra los ya guardados. Solo sugiere — nunca fusiona ni bloquea el guardado. */}
                {!selectedPatientId && (() => {
                  const phone = patientForm.phone.trim();
                  const fullName = `${patientForm.firstName.trim()} ${patientForm.lastName.trim()}`.trim().toLowerCase();
                  const match = patients.find(p => {
                    if (p.deletedAt) return false;
                    if (phone.length >= 7 && p.phoneEncrypted.trim() === phone) return true;
                    if (fullName.length > 3 && `${p.firstNameEncrypted} ${p.lastNameEncrypted}`.trim().toLowerCase() === fullName) return true;
                    return false;
                  });
                  if (!match) return null;
                  return (
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 animate-fade-in">
                      <div className="flex items-center gap-2.5 text-xs text-amber-800 dark:text-amber-300">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>
                          Ya existe un paciente similar: <strong>{match.firstNameEncrypted} {match.lastNameEncrypted}</strong> ({match.phoneEncrypted}). ¿Es la misma persona?
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSelectPatient(match.id)}
                        className="shrink-0 px-3.5 py-2 rounded-xl bg-amber-500 hover:brightness-110 text-white text-xs font-bold transition-all"
                      >
                        Usar este paciente
                      </button>
                    </div>
                  );
                })()}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Biotipo Cutáneo</label>
                    <select value={patientForm.skinBiotype} onChange={e => setPatientForm(prev => ({ ...prev, skinBiotype: e.target.value }))} required className="smart-input w-full px-4 py-3 rounded-xl text-sm appearance-none bg-no-repeat bg-[right_1rem_center]">
                      <option value="" disabled hidden>Seleccionar biotipo...</option>
                      <option value="Piel Mixta">Piel Mixta</option>
                      <option value="Piel Alípica">Piel Alípica</option>
                      <option value="Piel Grasa">Piel Grasa</option>
                      <option value="Piel Eudermica">Piel Eudermica</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Fototipo Fitzpatrick</label>
                    <input type="number" min="1" max="6" value={patientForm.fitzpatrickScale} onChange={e => setPatientForm(prev => ({ ...prev, fitzpatrickScale: parseInt(e.target.value) || 1 }))} className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                  <SuggestField
                    label="Protocolo"
                    value={patientForm.medicalDiagnosis}
                    onChange={val => setPatientForm(prev => ({ ...prev, medicalDiagnosis: val }))}
                    options={allCapturedProtocols}
                    placeholder="P. ej., Limpieza profunda, Peeling..."
                    hint=""
                    emptyLabel="Protocolos usados antes"
                    addNewLabel="Usar"
                    inputClassName="smart-input w-full px-4 py-3 rounded-xl text-sm"
                  />
                </div>

                {/* Consentimiento Informado: checkbox en escritorio (no hay paciente frente a un mouse
                    para firmar), firma táctil real en iPad/tablet (sí lo hay, en el punto de consulta). */}
                {isTouchDevice ? (
                  <div className="p-4 rounded-2xl bg-amber-500/5 border border-amber-500/20 space-y-3">
                    <div className="flex items-center gap-2.5">
                      <ShieldCheck className="w-5 h-5 text-amber-500 shrink-0" />
                      <span className="font-bold text-xs text-slate-800 dark:text-white">Consentimiento Informado Clínico — Firma del Paciente</span>
                    </div>
                    {/* La firma solo se dibuja dentro del modal de pantalla completa (un único canvas
                        activo a la vez); aquí solo se muestra una vista estática de lo ya capturado
                        para evitar dos canvases desincronizados mostrando cosas distintas. */}
                    <div className="ml-0 sm:ml-[30px] flex items-center justify-between gap-3 flex-wrap p-3 rounded-xl border border-dashed border-slate-300 dark:border-white/10 bg-white/50 dark:bg-white/[0.02]">
                      <div className="flex items-center gap-3 min-w-0">
                        {patientForm.signatureData ? (
                          <img src={patientForm.signatureData} alt="Firma del paciente" className="h-10 w-24 object-contain bg-white rounded-md border border-slate-200 shrink-0" />
                        ) : (
                          <div className="h-10 w-24 rounded-md border border-dashed border-slate-300 dark:border-white/10 flex items-center justify-center text-[9px] text-slate-400 shrink-0">Sin firma</div>
                        )}
                        <span className={`text-[10px] font-semibold ${signatureValid ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                          {signatureValid ? 'Firma capturada' : 'Pendiente de firma'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsSignatureKioskOpen(true)}
                        className="bg-amber-500 hover:brightness-110 text-white px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm shrink-0"
                      >
                        <Maximize2 className="w-3.5 h-3.5" /> {patientForm.signatureData ? 'Ver / Volver a firmar' : 'Entregar al paciente para firmar'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <label className="flex items-center gap-3 p-4 rounded-2xl bg-amber-500/5 border border-amber-500/20 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={patientForm.consentAccepted}
                      onChange={e => setPatientForm(prev => ({ ...prev, consentAccepted: e.target.checked }))}
                      className="w-5 h-5 rounded accent-amber-500 shrink-0"
                    />
                    <ShieldCheck className="w-5 h-5 text-amber-500 shrink-0" />
                    <div>
                      <span className="font-bold text-xs text-slate-800 dark:text-white block">Consentimiento Informado Clínico</span>
                      <span className="text-[10px] text-slate-400">
                        Confirmo que el paciente otorgó su consentimiento (verbal o en papel) para el tratamiento
                      </span>
                    </div>
                  </label>
                )}

                {isSignatureKioskOpen && (
                  <SignatureKioskModal
                    patientName={`${patientForm.firstName} ${patientForm.lastName}`.trim() || undefined}
                    value={patientForm.signatureData || undefined}
                    onChange={(dataUrl, valid) => {
                      setPatientForm(prev => ({ ...prev, signatureData: dataUrl || '' }));
                      setSignatureValid(valid);
                    }}
                    onDone={() => setIsSignatureKioskOpen(false)}
                  />
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <SuggestField
                    label="Alergias"
                    value={patientForm.allergies}
                    onChange={val => setPatientForm(prev => ({ ...prev, allergies: val }))}
                    options={allCapturedAllergies}
                    placeholder="P. ej., Alergia al látex, fragancias, cosméticos..."
                    hint=""
                    emptyLabel="Alergias ya registradas"
                    addNewLabel="Usar"
                    inputClassName="smart-input w-full px-4 py-3 rounded-xl text-sm"
                  />
                  <SuggestField
                    label="Condiciones Médicas/Procedimientos Qx"
                    value={patientForm.medicalConditions}
                    onChange={val => setPatientForm(prev => ({ ...prev, medicalConditions: val }))}
                    options={allCapturedMedicalConditions}
                    placeholder="P. ej., Diabetes, embarazo, hipertensión, rinoplastia previa..."
                    hint=""
                    emptyLabel="Condiciones ya registradas"
                    addNewLabel="Usar"
                    inputClassName="smart-input w-full px-4 py-3 rounded-xl text-sm"
                  />
                </div>

                {/* Condición (Skin Conditions) */}
                <div className="flex flex-col gap-2 p-6 rounded-2xl liquid-glass-light border border-slate-200/50 dark:border-white/5">
                  <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1 mb-2">Condición Cutánea (Multiselección)</label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {['Deshidratada', 'Asfixiada/ocluida', 'Sensible', 'Acneica', 'Desvitalizada', 'Poro fino', 'Poro dilatado'].map(cond => {
                      let isChecked = false;
                      try {
                        isChecked = JSON.parse(patientForm.skinConditions || '[]').includes(cond);
                      } catch (e) {}
                      return (
                        <label key={cond} className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer ${isChecked ? 'bg-amber-500/10 border-amber-500 text-amber-900 dark:text-amber-300' : 'bg-slate-50/50 dark:bg-white/5 border-slate-200/50 dark:border-white/5 text-slate-600 dark:text-luxe-300 hover:bg-slate-100/50 dark:hover:bg-white/10'}`}>
                          <input type="checkbox" checked={isChecked} onChange={() => toggleSkinCondition(cond)} className="w-4 h-4 rounded text-amber-500 border-slate-300 focus:ring-amber-500 dark:bg-slate-800 dark:border-slate-700" />
                          <span className="text-xs font-medium">{cond}</span>
                        </label>
                      );
                    })}
                    
                    {/* Otro Option */}
                    {(() => {
                      let parsed: string[] = [];
                      try {
                        parsed = JSON.parse(patientForm.skinConditions || '[]');
                      } catch (e) {}
                      const hasCustom = parsed.some((c: string) => !['Deshidratada', 'Asfixiada/ocluida', 'Sensible', 'Acneica', 'Desvitalizada', 'Poro fino', 'Poro dilatado'].includes(c));
                      return (
                        <label className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-pointer ${hasCustom ? 'bg-amber-500/10 border-amber-500 text-amber-900 dark:text-amber-300' : 'bg-slate-50/50 dark:bg-white/5 border-slate-200/50 dark:border-white/5 text-slate-600 dark:text-luxe-300 hover:bg-slate-100/50 dark:hover:bg-white/10'}`}>
                          <input type="checkbox" checked={hasCustom} onChange={toggleOtroCondition} className="w-4 h-4 rounded text-amber-500 border-slate-300 focus:ring-amber-500 dark:bg-slate-800 dark:border-slate-700" />
                          <span className="text-xs font-medium">Otro</span>
                        </label>
                      );
                    })()}
                  </div>

                  {/* Dynamic Custom input if "Otro" is active */}
                  {(() => {
                    let parsed: string[] = [];
                    try {
                      parsed = JSON.parse(patientForm.skinConditions || '[]');
                    } catch (e) {}
                    const hasCustom = parsed.some((c: string) => !['Deshidratada', 'Asfixiada/ocluida', 'Sensible', 'Acneica', 'Desvitalizada', 'Poro fino', 'Poro dilatado'].includes(c));
                    if (hasCustom) {
                      return (
                        <div className="mt-4 animate-fade-in">
                          <SuggestField
                            label="Especifique Otra Condición"
                            value={customConditionInput}
                            onChange={handleCustomConditionChange}
                            options={allCapturedCustomSkinConditions}
                            placeholder="Describa la condición de la piel..."
                            hint=""
                            emptyLabel="Otras condiciones ya registradas"
                            addNewLabel="Usar"
                            inputClassName="smart-input w-full px-4 py-3 rounded-xl text-sm"
                          />
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>

                {/* Facial Canvas Map */}
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Notas Clínicas SOAP / Zonas Afectadas</label>
                  <textarea ref={notesTextareaRef} value={patientForm.clinicalNotes} onChange={e => setPatientForm(prev => ({ ...prev, clinicalNotes: e.target.value }))} rows={6} placeholder="Diagnóstico de cabina y observaciones clínicas..." required className="smart-input w-full p-4 rounded-xl text-sm resize-none" />
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Mapa Facial Clínico Interactivo</label>
                  <div className="liquid-glass-light rounded-[24px] p-4 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4 border border-slate-200/50 dark:border-white/5 min-h-[220px]">
                    <div className="flex items-center justify-center">
                      <div
                        className="relative w-full max-w-[260px] rounded-2xl overflow-hidden border border-slate-200/60 dark:border-white/10 bg-slate-100 dark:bg-white/5"
                        style={{ aspectRatio: '912 / 1146' }}
                        onMouseMove={e => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                        }}
                        onMouseLeave={() => setHoveredZone(null)}
                      >
                        <img
                          src={`${import.meta.env.BASE_URL}mapa_facial_referencia.png?v=1`}
                          alt="Mapa facial de referencia"
                          onLoad={() => setIsBackdropLoaded(true)}
                          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${isBackdropLoaded ? 'opacity-100' : 'opacity-0'}`}
                        />
                        {!isBackdropLoaded && (
                          <div className="absolute inset-0 flex items-center justify-center text-center px-4 text-[9px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest">
                            Cargando mapa facial...
                          </div>
                        )}
                        <svg viewBox="0 0 912 1146" className="absolute inset-0 w-full h-full">
                          {Object.entries(FACIAL_ZONES).map(([key, zone]) => {
                            const isActive = activeFacialZones[key];
                            const isHovered = hoveredZone === key;
                            return (
                              <path
                                key={key}
                                d={zone.d}
                                onClick={() => toggleFacialZone(key, zone.label)}
                                onMouseEnter={() => setHoveredZone(key)}
                                onMouseLeave={() => setHoveredZone(prev => (prev === key ? null : prev))}
                                className="cursor-pointer transition-colors"
                                fill={isActive ? 'rgba(212,175,55,0.16)' : isHovered ? 'rgba(212,175,55,0.08)' : 'rgba(212,175,55,0.01)'}
                                stroke={isActive ? '#D4AF37' : isHovered ? 'rgba(212,175,55,0.85)' : 'rgba(212,175,55,0.35)'}
                                strokeWidth={isActive ? 6.5 : 3.2}
                              >
                                <title>{zone.label}</title>
                              </path>
                            );
                          })}
                        </svg>
                        {hoveredZone && FACIAL_ZONES[hoveredZone] && (
                          <div
                            className="absolute z-10 pointer-events-none px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wide text-white bg-black/85 border border-amber-400/70 whitespace-nowrap"
                            style={{ left: mousePos.x, top: Math.max(mousePos.y - 28, 4), transform: 'translateX(-50%)' }}
                          >
                            {FACIAL_ZONES[hoveredZone].label}{activeFacialZones[hoveredZone] ? ' (ACTIVO)' : ''}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 content-start max-h-[280px] overflow-y-auto pr-1">
                      {Object.entries(FACIAL_ZONES).map(([key, zone]) => {
                        const isActive = activeFacialZones[key];
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => toggleFacialZone(key, zone.label)}
                            onMouseEnter={() => setHoveredZone(key)}
                            onMouseLeave={() => setHoveredZone(null)}
                            title={zone.label}
                            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-[10px] font-semibold border transition-colors ${isActive ? 'bg-amber-500/15 border-amber-500 text-amber-800 dark:text-amber-300' : 'bg-slate-50/50 dark:bg-white/5 border-slate-200/50 dark:border-white/5 text-slate-600 dark:text-luxe-300 hover:bg-amber-500/10 hover:border-amber-500/40'}`}
                          >
                            <span className={`w-2 h-2 rounded-full shrink-0 ${isActive ? 'bg-amber-500' : 'bg-slate-300 dark:bg-white/20'}`} />
                            <span className="truncate">{zone.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Recomendaciones y Sugerencias de Apoyo */}
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Recomendaciones y Sugerencias de Apoyo (Opcional - Rutinas de lavado, hábitos, etc.)</label>
                  <textarea value={patientForm.recommendations} onChange={e => setPatientForm(prev => ({ ...prev, recommendations: e.target.value }))} rows={4} placeholder="Escribe aquí sugerencias opcionales de cuidado en casa, tipos de rutinas de lavado, frecuencia de mantenimiento, etc..." className="smart-input w-full p-4 rounded-xl text-sm resize-none" />
                  {(() => {
                    const already = patientForm.recommendations.toLowerCase();
                    const chips = allCapturedRecommendationPhrases.filter(p => !already.includes(p.toLowerCase())).slice(0, 6);
                    if (chips.length === 0) return null;
                    return (
                      <div className="flex flex-wrap gap-1.5 mt-0.5">
                        {chips.map(phrase => (
                          <button
                            key={phrase}
                            type="button"
                            onClick={() => setPatientForm(prev => ({
                              ...prev,
                              recommendations: prev.recommendations.trim() ? `${prev.recommendations.trim()}\n- ${phrase}` : `- ${phrase}`
                            }))}
                            className="px-2 py-1 rounded-full text-[10px] font-semibold bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-luxe-300 border border-slate-200/50 dark:border-white/10 hover:bg-amber-500/10 hover:border-amber-500/40 hover:text-amber-700 dark:hover:text-amber-300 transition-colors max-w-full truncate"
                            title={phrase}
                          >
                            + {phrase}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                {/* Fotografías Antes / Después */}
                <BeforeAfterSlider
                  beforeImages={parseImageList(patientForm.beforeImageUrl)}
                  afterImages={parseImageList(patientForm.afterImageUrl)}
                  onBeforeImagesChange={imgs => setPatientForm(prev => ({ ...prev, beforeImageUrl: serializeImageList(imgs) }))}
                  onAfterImagesChange={imgs => setPatientForm(prev => ({ ...prev, afterImageUrl: serializeImageList(imgs) }))}
                />

                {/* Diseñador de Pasos del Protocolo */}
                <div className="liquid-glass-light rounded-2xl p-6 border border-slate-200/50 dark:border-white/5 space-y-6">
                  <h3 className="font-outfit text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                    <Layers className="w-4 h-4 text-bronze-500" />
                    Diseñador de Procedimiento (Fases de Cabina)
                  </h3>
                  
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 bg-slate-500/5 p-6 rounded-[24px] border border-slate-200/20">
                    <div className="lg:col-span-5 space-y-4 flex flex-col justify-between">
                      <div className="flex flex-col gap-2 relative">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Buscar Producto en Catálogo</label>
                        <input type="text" value={stepSearchQuery} onChange={e => handleProductSearch(e.target.value)} placeholder="🔍 Escriba para buscar..." className="smart-input w-full" />
                        {stepSuggestions.length > 0 && (
                          <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-luxe-900 shadow-xl max-h-52 overflow-y-auto">
                            {stepSuggestions.map(p => (
                              <div key={p.id} onClick={() => selectSearchProduct(p)} className="p-2.5 hover:bg-slate-100 dark:hover:bg-white/5 border-b border-slate-100 dark:border-white/5 last:border-0 cursor-pointer text-xs flex items-center justify-between gap-2">
                                <span className="font-bold text-slate-800 dark:text-white">{p.name} ({p.brandLine})</span>
                                {productMatchesBiotype(p, patientForm.skinBiotype) && (
                                  <span className="shrink-0 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">✓ Biotipo</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Fase / Protocolo Clínico</label>
                        <select value={stepInput.stepName} onChange={e => setStepInput(prev => ({ ...prev, stepName: e.target.value }))} className="smart-input w-full">
                          <option value="Limpieza">Limpieza / Higiene</option>
                          <option value="Shampoo">Shampoo Facial</option>
                          <option value="Exfoliación">Exfoliación</option>
                          <option value="Peeling">Peeling</option>
                          <option value="Tonificación">Tonificación / Loción</option>
                          <option value="Armonizador">Armonizador</option>
                          <option value="Sérum">Sérum</option>
                          <option value="Activo">Activo Concentrado</option>
                          <option value="Mascarilla">Mascarilla</option>
                          <option value="Crema de Sellado">Crema de Sellado</option>
                          <option value="Protección Solar">Protección Solar</option>
                          <option value="Apoyo en Casa">Apoyo en Casa</option>
                          <option value="Otro">Otro</option>
                        </select>
                        {stepInput.stepName === 'Otro' && (
                          <input type="text" value={stepInput.customStepName} onChange={e => setStepInput(prev => ({ ...prev, customStepName: e.target.value }))} placeholder="Especificar Fase/Protocolo..." className="smart-input w-full mt-2" />
                        )}
                      </div>
                    </div>

                    <div className="lg:col-span-7 space-y-4">
                      <div className="grid grid-cols-2 touch:grid-cols-1 gap-3">
                        <input type="text" value={stepInput.customProductName} onChange={e => setStepInput(prev => ({ ...prev, customProductName: e.target.value }))} placeholder="Nombre del Producto..." className="smart-input w-full touch:py-3 touch:text-sm" />
                        <SuggestField
                          value={stepInput.customBrand}
                          onChange={val => setStepInput(prev => ({ ...prev, customBrand: val }))}
                          options={allCapturedBrands}
                          placeholder="Marca/Línea..."
                          hint=""
                          emptyLabel="Marcas en catálogo"
                          addNewLabel="Usar"
                          inputClassName="smart-input w-full touch:py-3 touch:text-sm"
                        />
                      </div>
                      <div className="grid grid-cols-2 touch:grid-cols-1 gap-3">
                        <div className="flex flex-col gap-1.5">
                          <input type="text" value={stepInput.customActiveIngredients} onChange={e => setStepInput(prev => ({ ...prev, customActiveIngredients: e.target.value }))} placeholder="Activos Clave..." className="smart-input w-full touch:py-3 touch:text-sm" />
                          <SuggestChips
                            value={stepInput.customActiveIngredients}
                            onChange={val => setStepInput(prev => ({ ...prev, customActiveIngredients: val }))}
                            options={alphabeticalIngredientsCatalog.map(i => i.name)}
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <input type="text" value={stepInput.customActions} onChange={e => setStepInput(prev => ({ ...prev, customActions: e.target.value }))} placeholder="Acción / Efecto Clínico..." className="smart-input w-full touch:py-3 touch:text-sm" />
                          <SuggestChips
                            value={stepInput.customActions}
                            onChange={val => setStepInput(prev => ({ ...prev, customActions: val }))}
                            options={allCapturedActions}
                          />
                        </div>
                      </div>
                      <textarea value={stepInput.applicationDescription} onChange={e => setStepInput(prev => ({ ...prev, applicationDescription: e.target.value }))} rows={2} placeholder="Descripción de Aplicación (maniobras, pose, neutralizador...)" className="smart-input w-full resize-none" />

                      <div className="flex flex-col gap-2">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Aparatología Aplicada</label>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-500/5 p-3 rounded-xl border border-slate-200/20">
                          {['Galvánica', 'Alta frecuencia', 'Farádica', 'Capacitiva', 'LASER', 'Infrarrojos', 'Ultrasonido', 'LED´s'].map(op => {
                            let isChecked = false;
                            try {
                              isChecked = JSON.parse(stepInput.aparatologySettings || '[]').includes(op);
                            } catch(e) {}
                            return (
                              <label key={op} className="flex items-center gap-1.5 cursor-pointer text-[11px] font-medium text-slate-700 dark:text-luxe-200">
                                <input type="checkbox" checked={isChecked} onChange={() => toggleAparatology(op)} className="rounded border-slate-350 w-3.5 h-3.5" />
                                <span>{op}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      {editingStepIndex !== null ? (
                        <div className="flex gap-2">
                          <button type="button" onClick={handleAddStep} className="flex-1 bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md">
                            Guardar Cambios de Paso
                          </button>
                          <button type="button" onClick={cancelEditStep} className="px-4 bg-slate-200 hover:bg-slate-300 dark:bg-white/10 dark:hover:bg-white/20 text-slate-700 dark:text-luxe-200 py-2 rounded-xl text-xs font-semibold transition-all">
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={handleAddStep} className="w-full bg-gradient-to-r from-bronze-500 to-bronze-600 hover:brightness-110 text-white py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5">
                          <Plus className="w-4 h-4" /> Agregar Paso al Protocolo
                        </button>
                      )}
                    </div>
                  </div>

                  {/* List of Added Steps: misma conversión a tarjetas en touch que la tabla de
                      apoyo domiciliario (7 columnas es aún peor para encimarse en un iPad). */}
                  <div className="border border-slate-200/50 dark:border-white/5 rounded-2xl overflow-hidden bg-white/40 dark:bg-luxe-950/20">
                    {(() => {
                      const resolveProductLabel = (step: typeof currentSteps[number]) => {
                        const nameLower = (step.customProductName || '').toLowerCase();
                        if (nameLower === 'sin producto' || !step.customProductName) {
                          if (step.aparatologySettings) {
                            try {
                              const parsed = JSON.parse(step.aparatologySettings);
                              if (Array.isArray(parsed) && parsed.length > 0) {
                                return `Aparatología: ${parsed.join(', ')}`;
                              }
                            } catch (e) {}
                            return `Aparatología: ${step.aparatologySettings}`;
                          }
                        }
                        return step.customProductName;
                      };

                      if (currentSteps.length === 0) {
                        return isTouchDevice ? (
                          <div className="py-6 px-4 text-center text-slate-400 italic text-xs">No se han añadido pasos.</div>
                        ) : (
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="bg-slate-100/60 dark:bg-white/5 border-b border-slate-200/50 dark:border-white/5 text-[10px] font-bold uppercase tracking-wider">
                                <th className="py-3 px-4">Orden</th>
                                <th className="py-3 px-4">Protocolo</th>
                                <th className="py-3 px-4">Producto</th>
                                <th className="py-3 px-4">Marca</th>
                                <th className="py-3 px-4">Activo</th>
                                <th className="py-3 px-4">Acción</th>
                                <th className="py-3 px-4 text-right">Acciones</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr>
                                <td colSpan={7} className="py-6 text-center text-slate-400 italic">No se han añadido pasos.</td>
                              </tr>
                            </tbody>
                          </table>
                        );
                      }

                      if (isTouchDevice) {
                        return (
                          <div className="divide-y divide-slate-200/50 dark:divide-white/5">
                            {currentSteps.map((step, idx) => (
                              <div key={step.id} className="p-4 flex flex-col gap-2.5">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex items-start gap-2.5 min-w-0">
                                    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-bronze-500/10 text-bronze-600 dark:text-bronze-400 font-bold text-[11px] shrink-0 mt-0.5">
                                      {step.stepOrder}
                                    </span>
                                    <div className="min-w-0">
                                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide block">{step.stepName}</span>
                                      <span className="font-semibold text-slate-800 dark:text-white block truncate">{resolveProductLabel(step)}</span>
                                      <span className="text-[10px] text-slate-400 block truncate">{step.customBrand}</span>
                                    </div>
                                  </div>
                                  <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                                    <button type="button" onClick={() => moveStepUp(idx)} disabled={idx === 0} className={`w-10 h-10 rounded-xl flex items-center justify-center ${idx === 0 ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-luxe-300 bg-slate-100 dark:bg-white/5'}`} title="Subir">▲</button>
                                    <button type="button" onClick={() => moveStepDown(idx)} disabled={idx === currentSteps.length - 1} className={`w-10 h-10 rounded-xl flex items-center justify-center ${idx === currentSteps.length - 1 ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-luxe-300 bg-slate-100 dark:bg-white/5'}`} title="Bajar">▼</button>
                                    <button type="button" onClick={() => editStep(idx)} className="w-10 h-10 rounded-xl flex items-center justify-center text-bronze-600 dark:text-bronze-400 bg-bronze-500/10" title="Editar"><Pencil className="w-4 h-4" /></button>
                                    <button type="button" onClick={() => removeStep(idx)} className="w-10 h-10 rounded-xl flex items-center justify-center text-red-500 bg-red-500/10" title="Eliminar"><Trash2 className="w-4 h-4" /></button>
                                  </div>
                                </div>
                                <div className="text-[11px] text-slate-600 dark:text-luxe-300">
                                  <span className="font-bold text-slate-500 dark:text-slate-400">Activos: </span>
                                  {step.customActiveIngredients || 'N/A'}
                                </div>
                                <div className="text-[11px] text-slate-600 dark:text-luxe-300">
                                  <span className="font-bold text-slate-500 dark:text-slate-400">Acción: </span>
                                  {step.customActions || 'N/A'}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      }

                      return (
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="bg-slate-100/60 dark:bg-white/5 border-b border-slate-200/50 dark:border-white/5 text-[10px] font-bold uppercase tracking-wider">
                              <th className="py-3 px-4">Orden</th>
                              <th className="py-3 px-4">Protocolo</th>
                              <th className="py-3 px-4">Producto</th>
                              <th className="py-3 px-4">Marca</th>
                              <th className="py-3 px-4">Activo</th>
                              <th className="py-3 px-4">Acción</th>
                              <th className="py-3 px-4 text-right">Acciones</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                            {currentSteps.map((step, idx) => (
                              <tr key={step.id}>
                                <td className="py-3 px-4">{step.stepOrder}</td>
                                <td className="py-3 px-4 font-bold">{step.stepName}</td>
                                <td className="py-3 px-4">{resolveProductLabel(step)}</td>
                                <td className="py-3 px-4">{step.customBrand}</td>
                                <td className="py-3 px-4 truncate max-w-[150px]">{step.customActiveIngredients || 'N/A'}</td>
                                <td className="py-3 px-4 truncate max-w-[150px]">{step.customActions || 'N/A'}</td>
                                <td className="py-3 px-4 text-right space-x-2">
                                  <button type="button" onClick={() => moveStepUp(idx)} disabled={idx === 0} className={`inline-flex items-center gap-1 text-[11px] ${idx === 0 ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-600 dark:text-luxe-300 hover:text-amber-500'}`} title="Subir">▲</button>
                                  <button type="button" onClick={() => moveStepDown(idx)} disabled={idx === currentSteps.length - 1} className={`inline-flex items-center gap-1 text-[11px] ${idx === currentSteps.length - 1 ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-600 dark:text-luxe-300 hover:text-amber-500'}`} title="Bajar">▼</button>
                                  <button type="button" onClick={() => editStep(idx)} className="text-bronze-600 dark:text-bronze-400 hover:underline inline-flex items-center gap-1" title="Editar"><Pencil className="w-3.5 h-3.5" /></button>
                                  <button type="button" onClick={() => removeStep(idx)} className="text-red-500 hover:underline inline-flex items-center gap-1" title="Eliminar"><Trash2 className="w-3.5 h-3.5" /></button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    })()}
                    {prescriptionsList.length > 0 && (
                      <div className="p-4 border-t border-slate-200/50 dark:border-white/5 flex justify-end bg-slate-50/50 dark:bg-luxe-950/10">
                        <button
                          type="button"
                          onClick={handleSaveCurrentProtocolAsPreset}
                          className="bg-gradient-to-r from-amber-500/10 to-amber-600/10 hover:from-amber-500/20 hover:to-amber-600/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 px-4 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm"
                        >
                          <Save className="w-3.5 h-3.5" /> Guardar como Rutina Predeterminada
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Protocolos de Apoyo en Casa (Rediseño Vanguardista Cosmetológico) */}
                <div className="liquid-glass-light rounded-2xl p-6 border border-slate-200/50 dark:border-white/5 space-y-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200/50 dark:border-white/5 pb-4">
                    <div>
                      <h3 className="font-outfit text-base font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                        <Wand2 className="w-5 h-5 text-amber-500" />
                        Diseñador Inteligente de Apoyo Domiciliario
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-luxe-300 mt-0.5">
                        Prescripción cosmetológica guiada por biotipo, capas de aplicación (Layering) y control clínico de activos.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleAutoGenerateHomeRoutine}
                        className="bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-md"
                        title="Genera automáticamente el kit de inicio sugerido para el biotipo actual"
                      >
                        <Sparkles className="w-3.5 h-3.5" /> Sugerir por Biotipo ({patientForm.skinBiotype || 'General'})
                      </button>

                      <button
                        type="button"
                        onClick={() => setShowDigitalClientModal(true)}
                        className="bg-slate-100 hover:bg-slate-200 dark:bg-white/10 dark:hover:bg-white/20 text-slate-700 dark:text-white px-3.5 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 border border-slate-200/50 dark:border-white/10"
                      >
                        <Eye className="w-3.5 h-3.5 text-blue-500" /> Vista Digital Paciente
                      </button>
                    </div>
                  </div>

                  {/* Rubro Opcional para Nombre Personalizado del Protocolo de Apoyo en Casa */}
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 bg-amber-500/5 p-3 rounded-xl border border-amber-500/20">
                    <label className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-widest shrink-0 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-amber-500" /> Nombre del Protocolo (Opcional):
                    </label>
                    <input
                      type="text"
                      value={homeProtocolName}
                      onChange={e => setHomeProtocolName(e.target.value)}
                      placeholder="Ej. Rutina Antiedad Intensiva, Protocolo Despigmentante de Verano (no obligatorio)..."
                      className="smart-input w-full text-xs py-1.5 px-3 font-semibold"
                    />
                  </div>

                  {/* Banner de Alertas Clínicas de Seguridad e Incompatibilidad de Activos */}
                  {(() => {
                    const alerts = analyzePrescriptionSafety(prescriptionsList);
                    if (alerts.length === 0) return null;
                    return (
                      <div className="space-y-2 animate-fade-in">
                        {alerts.map((alert, i) => (
                          <div
                            key={i}
                            className={`p-3.5 rounded-xl border flex items-start gap-3 text-xs ${
                              alert.severity === 'danger'
                                ? 'bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300'
                                : alert.severity === 'warning'
                                ? 'bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-300'
                                : 'bg-blue-500/10 border-blue-500/30 text-blue-800 dark:text-blue-300'
                            }`}
                          >
                            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                            <div className="space-y-0.5">
                              <span className="font-bold block">{alert.title}</span>
                              <p className="opacity-90">{alert.message}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Panel de Selección Dual y Captura de Producto */}
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 bg-slate-500/5 p-5 rounded-[24px] border border-slate-200/20">
                    <div className="lg:col-span-5 space-y-4 flex flex-col justify-between">
                      <div ref={presContainerRef} className="flex flex-col gap-1.5 relative">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Buscar en Catálogo Dermoestético</label>
                        <input
                          type="text"
                          value={presSearchQuery}
                          onChange={e => handlePresProductSearch(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Escape') setPresSuggestions([]); }}
                          placeholder="🔍 Buscar por marca, nombre o activo..."
                          className="smart-input w-full"
                        />
                        {presSuggestions.length > 0 && (
                          <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-luxe-900 shadow-xl max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5">
                            {presSuggestions.map(p => (
                              <div
                                key={p.id}
                                onClick={() => selectPresSearchProduct(p)}
                                className="p-2.5 hover:bg-amber-500/10 cursor-pointer text-xs transition-colors flex items-center justify-between"
                              >
                                <div>
                                  <span className="font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                                    {p.name}
                                    {productMatchesBiotype(p, patientForm.skinBiotype) && (
                                      <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400">✓ Biotipo</span>
                                    )}
                                  </span>
                                  <span className="text-[10px] text-slate-400">{p.brandLine}</span>
                                </div>
                                <span className="text-[10px] font-semibold text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-md shrink-0">Cargar</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Fase Técnica / Capa Cosmetológica</label>
                        <select value={presInput.stepName} onChange={e => setPresInput(prev => ({ ...prev, stepName: e.target.value }))} className="smart-input w-full">
                          <option value="Limpieza / Higiene">1. Limpieza / Higiene 🧼</option>
                          <option value="Tonificación / Loción">2. Tonificación / Loción 💦</option>
                          <option value="Contorno de Ojos">3. Contorno de Ojos 👁️</option>
                          <option value="Suero / Activo Concentrado">4. Suero / Activo Concentrado 🧪</option>
                          <option value="Crema / Emulsión / Hidratante">5. Crema / Emulsión / Hidratante 🧴</option>
                          <option value="Protección Solar">6. Protección Solar ☀️</option>
                          <option value="Mascarilla Semanal">7. Mascarilla Semanal 🎭</option>
                          <option value="Exfoliación Semanal">8. Exfoliación Semanal ✨</option>
                          <option value="Otro">Otro</option>
                        </select>
                        {presInput.stepName === 'Otro' && (
                          <input type="text" value={presInput.customStepName} onChange={e => setPresInput(prev => ({ ...prev, customStepName: e.target.value }))} placeholder="Especificar Fase/Protocolo..." className="smart-input w-full mt-2" />
                        )}
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Horario de Aplicación</label>
                        <select value={presInput.timeOfDay} onChange={e => setPresInput(prev => ({ ...prev, timeOfDay: e.target.value as any }))} className="smart-input w-full">
                          <option value="Dia">☀️ Día (AM)</option>
                          <option value="Noche">🌙 Noche (PM)</option>
                          <option value="Dia y Noche">🔄 Día y Noche (AM + PM)</option>
                        </select>
                      </div>
                    </div>

                    <div className="lg:col-span-7 space-y-3.5">
                      <div className="grid grid-cols-2 touch:grid-cols-1 gap-3">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider block mb-1">Nombre Comercial</label>
                          <input type="text" value={presInput.customProductName} onChange={e => setPresInput(prev => ({ ...prev, customProductName: e.target.value }))} placeholder="Ej. Gel Limpiador Purificante..." className="smart-input w-full touch:py-3 touch:text-sm" />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider block mb-1">Laboratorio / Marca</label>
                          <SuggestField
                            value={presInput.customBrand}
                            onChange={val => setPresInput(prev => ({ ...prev, customBrand: val }))}
                            options={allCapturedBrands}
                            placeholder="Ej. Línea Clínica..."
                            hint=""
                            emptyLabel="Marcas en catálogo"
                            addNewLabel="Usar"
                            inputClassName="smart-input w-full touch:py-3 touch:text-sm"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 touch:grid-cols-1 gap-3">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider block mb-1">Activos Principales</label>
                          <input type="text" value={presInput.customActiveIngredients} onChange={e => setPresInput(prev => ({ ...prev, customActiveIngredients: e.target.value }))} placeholder="Ej. Ácido Salicílico 2%, Niacinamida..." className="smart-input w-full touch:py-3 touch:text-sm" />
                          <SuggestChips
                            value={presInput.customActiveIngredients}
                            onChange={val => setPresInput(prev => ({ ...prev, customActiveIngredients: val }))}
                            options={alphabeticalIngredientsCatalog.map(i => i.name)}
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider block mb-1">Efecto / Acción Cutánea</label>
                          <input type="text" value={presInput.customActions} onChange={e => setPresInput(prev => ({ ...prev, customActions: e.target.value }))} placeholder="Ej. Seborregulador, Calmante..." className="smart-input w-full touch:py-3 touch:text-sm" />
                          <SuggestChips
                            value={presInput.customActions}
                            onChange={val => setPresInput(prev => ({ ...prev, customActions: val }))}
                            options={allCapturedActions}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 touch:grid-cols-1 gap-3">
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider block mb-1">Dosis / Modo de Aplicación</label>
                          <input type="text" value={presInput.dosageInstructions} onChange={e => setPresInput(prev => ({ ...prev, dosageInstructions: e.target.value }))} placeholder="Ej. 3-4 gotas con masaje suave..." className="smart-input w-full touch:py-3 touch:text-sm" />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider block mb-1">Frecuencia</label>
                          <input type="text" value={presInput.applicationFrequency} onChange={e => setPresInput(prev => ({ ...prev, applicationFrequency: e.target.value }))} placeholder="Ej. Diario / 2 veces por semana..." className="smart-input w-full touch:py-3 touch:text-sm" />
                        </div>
                      </div>

                      {!presInput.dosageInstructions.trim() && !presInput.applicationFrequency.trim() && (() => {
                        const phaseName = presInput.stepName === 'Otro' ? presInput.customStepName : presInput.stepName;
                        const suggestedDosage = getDefaultDosageInstructions(phaseName);
                        const suggestedFrequency = getDefaultApplicationFrequency(phaseName, presInput.timeOfDay);
                        if (!suggestedDosage && !suggestedFrequency) return null;
                        return (
                          <button
                            type="button"
                            onClick={() => setPresInput(prev => ({
                              ...prev,
                              dosageInstructions: suggestedDosage || prev.dosageInstructions,
                              applicationFrequency: suggestedFrequency || prev.applicationFrequency
                            }))}
                            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-bold bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30 transition-colors"
                          >
                            <Sparkles className="w-3.5 h-3.5" /> Usar redacción sugerida para esta fase
                          </button>
                        );
                      })()}

                      {editingPrescriptionIndex !== null ? (
                        <div className="flex gap-2 pt-1">
                          <button type="button" onClick={handleAddPrescription} className="flex-1 bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md">
                            Guardar Cambios
                          </button>
                          <button type="button" onClick={cancelEditPrescription} className="px-4 bg-slate-200 hover:bg-slate-300 dark:bg-white/10 dark:hover:bg-white/20 text-slate-700 dark:text-luxe-200 py-2.5 rounded-xl text-xs font-semibold transition-all">
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={handleAddPrescription} className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md pt-1">
                          <Plus className="w-4 h-4" /> Agregar al Protocolo de Apoyo
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Pestañas de Rutina por Bloques de Tiempo (☀️ Mañana, 🌙 Noche, 📅 Semanal) */}
                  <div className="space-y-4 pt-2">
                    <div className="flex flex-col touch:items-stretch touch:gap-3 md:flex-row md:items-center justify-between border-b border-slate-200/50 dark:border-white/5 pb-2 gap-2">
                      <div className={isTouchDevice ? 'grid grid-cols-1 gap-2 w-full' : 'flex items-center flex-wrap gap-2'}>
                        <button
                          type="button"
                          onClick={() => setActiveProtocolTab('AM')}
                          className={`px-4 py-2 touch:w-full touch:py-3.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 whitespace-nowrap ${
                            activeProtocolTab === 'AM'
                              ? 'bg-amber-500 text-white shadow-md'
                              : 'bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'
                          }`}
                        >
                          <Sun className="w-4 h-4 text-amber-200 shrink-0" /> ☀️ Rutina de Día (AM)
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveProtocolTab('PM')}
                          className={`px-4 py-2 touch:w-full touch:py-3.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 whitespace-nowrap ${
                            activeProtocolTab === 'PM'
                              ? 'bg-indigo-600 text-white shadow-md'
                              : 'bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'
                          }`}
                        >
                          <Moon className="w-4 h-4 text-indigo-200 shrink-0" /> 🌙 Rutina de Noche (PM)
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveProtocolTab('SEMANAL')}
                          className={`px-4 py-2 touch:w-full touch:py-3.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 whitespace-nowrap ${
                            activeProtocolTab === 'SEMANAL'
                              ? 'bg-emerald-600 text-white shadow-md'
                              : 'bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'
                          }`}
                        >
                          <Calendar className="w-4 h-4 text-emerald-200 shrink-0" /> 📅 Cuidados Semanales
                        </button>
                      </div>

                      <span className="text-[11px] font-semibold text-slate-400">
                        {prescriptionsList.length} productos prescritos
                      </span>
                    </div>

                    {/* Tabla de Productos Prescritos por Pestaña: una tabla de 6 columnas no cabe en
                        un iPad sin encimarse (columnas comprimidas, texto cortado), así que en touch
                        se reemplaza por tarjetas apiladas con botones de edición/borrado de tamaño de
                        toque real; en escritorio la tabla original queda intacta. */}
                    <div className="border border-slate-200/50 dark:border-white/5 rounded-2xl overflow-hidden bg-white/40 dark:bg-luxe-950/20 shadow-sm">
                      {(() => {
                        const filteredList = prescriptionsList
                          .filter(p => {
                            if (activeProtocolTab === 'AM') return p.timeOfDay === 'Dia' || p.timeOfDay === 'Dia y Noche';
                            if (activeProtocolTab === 'PM') return p.timeOfDay === 'Noche' || p.timeOfDay === 'Dia y Noche';
                            const stepNorm = (p.stepName || '').toLowerCase();
                            return stepNorm.includes('semanal') || stepNorm.includes('mascarilla') || stepNorm.includes('exfolia');
                          })
                          .sort((a, b) => getLayerOrder(a.stepName || a.customProductName || '') - getLayerOrder(b.stepName || b.customProductName || ''));

                        const emptyMsg = `No hay productos asignados para el bloque de ${activeProtocolTab === 'AM' ? 'Mañana ☀️' : activeProtocolTab === 'PM' ? 'Noche 🌙' : 'Cuidados Semanales 📅'}.`;

                        if (filteredList.length === 0) {
                          return isTouchDevice ? (
                            <div className="py-8 px-4 text-center text-slate-400 italic text-xs">{emptyMsg}</div>
                          ) : (
                            <table className="w-full text-left border-collapse text-xs">
                              <thead>
                                <tr className="bg-slate-100/60 dark:bg-white/5 border-b border-slate-200/50 dark:border-white/5 text-[10px] font-bold uppercase tracking-wider">
                                  <th className="py-3 px-4 w-12 text-center">Capa</th>
                                  <th className="py-3 px-4">Fase / Capa</th>
                                  <th className="py-3 px-4">Producto & Marca</th>
                                  <th className="py-3 px-4">Activos Clave</th>
                                  <th className="py-3 px-4">Instrucciones & Dosis</th>
                                  <th className="py-3 px-4 text-right">Acciones</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td colSpan={6} className="py-8 text-center text-slate-400 italic">{emptyMsg}</td>
                                </tr>
                              </tbody>
                            </table>
                          );
                        }

                        if (isTouchDevice) {
                          return (
                            <div className="divide-y divide-slate-200/50 dark:divide-white/5">
                              {filteredList.map((pres, idx) => {
                                const originalIdx = prescriptionsList.findIndex(p => p.id === pres.id);
                                const layerNum = getLayerOrder(pres.stepName || pres.customProductName || '');
                                return (
                                  <div key={pres.id} className="p-4 flex flex-col gap-2.5">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="flex items-start gap-2.5 min-w-0">
                                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold text-[11px] shrink-0 mt-0.5">
                                          {layerNum < 9 ? layerNum : idx + 1}
                                        </span>
                                        <div className="min-w-0">
                                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide block">{pres.stepName}</span>
                                          <span className="font-semibold text-slate-800 dark:text-white block truncate">{pres.customProductName || pres.productDetails?.name}</span>
                                          <span className="text-[10px] text-slate-400 block truncate">{pres.customBrand || pres.productDetails?.brandLine}</span>
                                        </div>
                                      </div>
                                      <div className="flex gap-1.5 shrink-0">
                                        <button type="button" onClick={() => editPrescription(originalIdx)} className="w-10 h-10 rounded-xl flex items-center justify-center text-amber-600 dark:text-amber-400 bg-amber-500/10" title="Editar"><Pencil className="w-4 h-4" /></button>
                                        <button type="button" onClick={() => removePrescription(originalIdx)} className="w-10 h-10 rounded-xl flex items-center justify-center text-red-500 bg-red-500/10" title="Eliminar"><Trash2 className="w-4 h-4" /></button>
                                      </div>
                                    </div>
                                    <div className="text-[11px] text-slate-600 dark:text-luxe-300">
                                      <span className="font-bold text-slate-500 dark:text-slate-400">Activos: </span>
                                      {pres.customActiveIngredients || 'N/A'}
                                    </div>
                                    <div className="text-[11px]">
                                      <span className="font-bold text-amber-600 dark:text-amber-400">Dosis: </span>
                                      <span className="text-slate-700 dark:text-luxe-200">{pres.dosageInstructions || 'Sin dosis específica'}</span>
                                      <span className="text-amber-600 dark:text-amber-400 font-semibold"> · {pres.applicationFrequency}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        }

                        return (
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="bg-slate-100/60 dark:bg-white/5 border-b border-slate-200/50 dark:border-white/5 text-[10px] font-bold uppercase tracking-wider">
                                <th className="py-3 px-4 w-12 text-center">Capa</th>
                                <th className="py-3 px-4">Fase / Capa</th>
                                <th className="py-3 px-4">Producto & Marca</th>
                                <th className="py-3 px-4">Activos Clave</th>
                                <th className="py-3 px-4">Instrucciones & Dosis</th>
                                <th className="py-3 px-4 text-right">Acciones</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                              {filteredList.map((pres, idx) => {
                                const originalIdx = prescriptionsList.findIndex(p => p.id === pres.id);
                                const layerNum = getLayerOrder(pres.stepName || pres.customProductName || '');
                                return (
                                  <tr key={pres.id} className="hover:bg-slate-500/5 transition-colors">
                                    <td className="py-3 px-4 text-center">
                                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold text-[11px]">
                                        {layerNum < 9 ? layerNum : idx + 1}
                                      </span>
                                    </td>
                                    <td className="py-3 px-4 font-bold text-slate-800 dark:text-white">{pres.stepName}</td>
                                    <td className="py-3 px-4">
                                      <span className="font-semibold text-slate-800 dark:text-white block">{pres.customProductName || pres.productDetails?.name}</span>
                                      <span className="text-[10px] text-slate-400">{pres.customBrand || pres.productDetails?.brandLine}</span>
                                    </td>
                                    <td className="py-3 px-4 max-w-[180px]">
                                      <span className="truncate block text-slate-600 dark:text-luxe-300">{pres.customActiveIngredients || 'N/A'}</span>
                                    </td>
                                    <td className="py-3 px-4">
                                      <span className="font-medium text-slate-700 dark:text-luxe-200 block">{pres.dosageInstructions || 'Sin dosis específica'}</span>
                                      <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">{pres.applicationFrequency}</span>
                                    </td>
                                    <td className="py-3 px-4 text-right space-x-2">
                                      <button type="button" onClick={() => editPrescription(originalIdx)} className="text-amber-600 dark:text-amber-400 hover:underline inline-flex items-center gap-1" title="Editar"><Pencil className="w-3.5 h-3.5" /></button>
                                      <button type="button" onClick={() => removePrescription(originalIdx)} className="text-red-500 hover:underline inline-flex items-center gap-1" title="Eliminar"><Trash2 className="w-3.5 h-3.5" /></button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        );
                      })()}

                      {prescriptionsList.length > 0 && (
                        <div className="p-4 border-t border-slate-200/50 dark:border-white/5 flex justify-end bg-slate-50/50 dark:bg-luxe-950/10">
                          <button
                            type="button"
                            onClick={handleSaveCurrentProtocolAsPreset}
                            className="bg-gradient-to-r from-amber-500/10 to-amber-600/10 hover:from-amber-500/20 hover:to-amber-600/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm"
                          >
                            <Save className="w-3.5 h-3.5" /> Guardar como Rutina Predeterminada
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>


                {/* Final Form Operations: en escritorio son 3 botones en fila alineados a la derecha;
                    en touch se apilan a ancho completo (misma altura de padding para los 3) para que
                    ninguno se corte ni el texto se parta en varias líneas dentro de un botón angosto. */}
                <div className="flex flex-col touch:gap-2.5 md:flex-row justify-end gap-4 pt-6 border-t border-slate-200/50 dark:border-white/5">
                  <button type="button" onClick={() => resetPatientForm()} className="touch:w-full touch:py-3.5 touch:order-3 px-5 py-3 rounded-xl text-slate-500 dark:text-luxe-300 hover:bg-slate-100 dark:hover:bg-white/5 text-xs font-semibold tracking-wide">
                    Limpiar Ficha
                  </button>
                  <button type="button" onClick={() => setIsPdfModalOpen(true)} className="touch:w-full touch:py-3.5 bg-gradient-to-r from-amber-500 to-bronze-600 hover:brightness-110 text-white px-6 py-3 rounded-xl text-xs font-bold shadow-lg transition-all flex items-center justify-center gap-2">
                    <FileText className="w-4 h-4 shrink-0" /> Exportar PDF Directo
                  </button>
                  <button type="submit" className="touch:w-full touch:py-3.5 bg-gradient-to-r from-bronze-500 to-bronze-600 hover:brightness-110 text-white px-8 py-3 rounded-xl text-xs font-bold shadow-lg transition-all flex items-center justify-center gap-2">
                    <Save className="w-4 h-4 shrink-0" /> Guardar Ficha Paciente
                  </button>
                </div>
              </form>
            </div>

            {/* Rutinas Preestablecidas de Apoyo en Casa */}
            <div className="liquid-glass rounded-3xl p-8 space-y-6 border border-slate-200/50 dark:border-white/5">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h2 className="font-outfit text-xl font-bold text-slate-800 dark:text-white flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-amber-500" />
                    APOYO EN CASA
                  </h2>
                  <p className="text-slate-500 dark:text-luxe-300 text-xs mt-1">
                    Seleccione un horario y tipo de tratamiento para cargar automáticamente rutinas preestablecidas con productos del catálogo o elija sus rutinas guardadas.
                  </p>
                </div>
              </div>

              {/* Botón Opción: Dia o Noche */}
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Horario de Rutina</span>
                <div className="flex gap-2">
                  {[
                    { value: 'Dia', label: 'Día', icon: Sun },
                    { value: 'Noche', label: 'Noche', icon: Moon }
                  ].map(opt => {
                    const Icon = opt.icon;
                    const isSelected = selectedRoutineTime === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setSelectedRoutineTime(opt.value as any)}
                        className={`flex items-center gap-1.5 px-6 py-2.5 rounded-xl text-xs font-bold transition-all border ${
                          isSelected
                            ? 'bg-gradient-to-r from-amber-500 to-amber-600 border-amber-500 text-white shadow-md'
                            : 'bg-white/40 dark:bg-luxe-950/20 border-slate-200/50 dark:border-white/5 text-slate-600 dark:text-luxe-200 hover:bg-slate-100 dark:hover:bg-white/5'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Botón Tx (con opciones) */}
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Opciones de Tratamiento (Tx)</span>
                <div className="flex flex-wrap gap-2">
                  {[
                    'Hidratante', 'Control de Melanogenesis', 'Regenerante', 'Hidratacion piel grasa',
                    'Despigmentante', 'reductivo de cuello', 'reafirmante facial y cuello',
                    'anti envejecimiento piel grasa', 'oxigenante', 'piel sensible',
                    'hidratacion corporal', 'nutricion', 'anti acne'
                  ].map(tx => {
                    const isSelected = selectedRoutineTx === tx && !selectedCustomRoutine;
                    return (
                      <button
                        key={tx}
                        type="button"
                        onClick={() => {
                          setSelectedRoutineTx(tx);
                          setSelectedCustomRoutine(null);
                        }}
                        className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all border ${
                          isSelected
                            ? 'bg-amber-600/15 border-amber-550 text-amber-600 dark:text-amber-400 shadow-sm'
                            : 'bg-white/20 dark:bg-luxe-950/10 border-slate-200/30 dark:border-white/5 text-slate-600 dark:text-luxe-300 hover:bg-slate-100 dark:hover:bg-white/5'
                        }`}
                      >
                        {tx}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Rutinas Guardadas Personalizadas */}
              {customRoutines.length > 0 && (
                <div className="flex flex-col gap-2 border-t border-slate-200/20 pt-4">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Mis Rutinas Predeterminadas</span>
                  <div className="flex flex-wrap gap-2">
                    {customRoutines.map(r => {
                      const isSelected = selectedCustomRoutine?.name === r.name;
                      return (
                        <div
                          key={r.name}
                          className={`flex items-center bg-white/20 dark:bg-luxe-950/10 border rounded-xl overflow-hidden hover:bg-slate-100 dark:hover:bg-white/5 transition-all ${
                            isSelected ? 'border-amber-500/50' : 'border-slate-200/30 dark:border-white/5'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCustomRoutine(r);
                              setSelectedRoutineTx('');
                            }}
                            className={`px-4 py-2 text-xs font-semibold transition-all ${
                              isSelected
                                ? 'bg-amber-600/15 text-amber-600 dark:text-amber-400 font-bold'
                                : 'text-slate-600 dark:text-luxe-300'
                            }`}
                          >
                            ⭐ {r.name}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDeleteCustomRoutine(r.name, e)}
                            className="px-2.5 py-2 text-red-500 hover:text-red-650 hover:bg-red-500/10 border-l border-slate-200/20 dark:border-white/5 transition-all text-xs"
                            title="Eliminar rutina"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Preview and Catalog Matching Section */}
              {selectedCustomRoutine ? (
                <div className="bg-slate-500/5 p-6 rounded-[24px] border border-slate-200/20 space-y-4 animate-fade-in">
                  <h3 className="text-xs font-bold text-slate-700 dark:text-white uppercase tracking-wider">
                    Detalle de la Rutina Guardada: {selectedCustomRoutine.name}
                  </h3>

                  <div className="space-y-4 divide-y divide-slate-200/10">
                    {selectedCustomRoutine.prescriptions.map((pres, idx) => (
                      <div key={idx} className="pt-4 first:pt-0 grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="space-y-1">
                          <span className="inline-block bg-amber-550/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                            {pres.stepName}
                          </span>
                          <h4 className="text-xs font-bold text-slate-800 dark:text-white mt-1">
                            {pres.customProductName || pres.productDetails?.name}
                          </h4>
                          <p className="text-[10px] text-slate-400 italic">
                            {pres.customBrand || pres.productDetails?.brandLine} - {pres.customActiveIngredients || 'N/A'}
                          </p>
                        </div>
                        
                        <div className="text-[11px] text-slate-650 dark:text-luxe-200 space-y-1 self-center col-span-2">
                          <p><strong>Horario:</strong> <span className="font-semibold text-amber-600 dark:text-amber-400">{pres.timeOfDay}</span></p>
                          <p><strong>Frecuencia:</strong> {pres.applicationFrequency}</p>
                          <p className="text-[10.5px]"><strong>Indicación:</strong> {pres.dosageInstructions}</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="pt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={applyCustomRoutineToPatient}
                      className="bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white px-8 py-3 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-2"
                    >
                      <Plus className="w-4.5 h-4.5" />
                      Cargar Rutina al Protocolo del Paciente
                    </button>
                  </div>
                </div>
              ) : (
                <div className="bg-slate-500/5 p-6 rounded-[24px] border border-slate-200/20 space-y-4 animate-fade-in">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-200/20 pb-3">
                    <div>
                      <h3 className="text-xs font-bold text-slate-700 dark:text-white uppercase tracking-wider">
                        Detalle de la Rutina: {selectedRoutineTx} ({selectedRoutineTime === 'Dia' ? 'Día' : 'Noche'})
                      </h3>
                      <p className="text-[11px] text-slate-400">
                        Edite el nombre de las fases, modifique dosis/indicaciones o asocie cualquier producto de su catálogo.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={handleAddStepToCurrentRoutine}
                      className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 self-start md:self-auto"
                    >
                      <Plus className="w-3.5 h-3.5" /> Agregar Fase a esta Rutina
                    </button>
                  </div>

                  <div className="space-y-4 divide-y divide-slate-200/10">
                    {(() => {
                      const steps = editableRoutineSteps.length > 0 
                        ? editableRoutineSteps 
                        : (ESTABLISHED_ROUTINES[selectedRoutineTx] ? (selectedRoutineTime === 'Dia' ? ESTABLISHED_ROUTINES[selectedRoutineTx].Dia : ESTABLISHED_ROUTINES[selectedRoutineTx].Noche) : []);

                      if (steps.length === 0) return <p className="text-xs text-slate-400 italic py-4">No hay fases configuradas en esta rutina.</p>;

                      return steps.map((step, idx) => {
                        const selectionKey = selectedRoutineTx + "_" + selectedRoutineTime + "_" + String(idx);
                        const selectedVal = routineStepSelections[selectionKey] || 'default';
                        const matches = getMatchingProductsForStep(step);
                        const autoProduct = selectedVal !== 'default' 
                          ? products.find(p => p.id === selectedVal) 
                          : (matches.length > 0 ? matches[0] : null);

                        const prodName = autoProduct ? autoProduct.name : step.defaultProductName;
                        const prodBrand = autoProduct ? autoProduct.brandLine : step.defaultBrand;
                        let prodActives = step.defaultActiveIngredients;
                        if (autoProduct) {
                          try {
                            const parsed = JSON.parse(autoProduct.activeIngredients || '[]');
                            prodActives = Array.isArray(parsed) ? parsed.join(', ') : autoProduct.activeIngredients;
                          } catch(e) {
                            prodActives = autoProduct.activeIngredients;
                          }
                        }

                        const isEditingThisStep = editingRoutineStepIdx === idx;

                        return (
                          <div key={idx} className="pt-4 first:pt-0 grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
                            {/* Columna 1: Nombre de Fase / Sección (Editable) */}
                            <div className="md:col-span-4 space-y-2">
                              <div className="flex items-center gap-2">
                                {isEditingThisStep ? (
                                  <div className="flex items-center gap-1.5 w-full">
                                    <input
                                      type="text"
                                      value={step.stepName}
                                      onChange={e => handleUpdateStepInRoutine(idx, 'stepName', e.target.value)}
                                      placeholder="Nombre de Fase (ej. Exfoliación)..."
                                      className="smart-input text-xs py-1 px-2.5 font-bold w-full"
                                      autoFocus
                                    />
                                    <button
                                      type="button"
                                      onClick={() => setEditingRoutineStepIdx(null)}
                                      className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold shrink-0"
                                      title="Guardar nombre"
                                    >
                                      ✓
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <span className="inline-block bg-amber-550/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                                      {step.stepName}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setEditingRoutineStepIdx(idx)}
                                      className="p-1 text-slate-400 hover:text-amber-500 transition-colors"
                                      title="Editar nombre de la fase"
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </button>
                                    {autoProduct && (
                                      <span className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[9px] font-bold px-2 py-0.5 rounded-md">
                                        ✓ Catálogo
                                      </span>
                                    )}
                                  </>
                                )}
                              </div>

                              <div className="pl-0.5 space-y-0.5">
                                <h4 className="text-xs font-bold text-slate-800 dark:text-white">{prodName}</h4>
                                <p className="text-[10px] text-slate-400 italic">{prodBrand} - {prodActives}</p>
                              </div>
                            </div>
                            
                            {/* Columna 2: Frecuencia e Indicaciones (Editables) */}
                            <div className="md:col-span-4 text-[11px] space-y-1.5">
                              <div>
                                <label className="text-[9px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider block">Frecuencia</label>
                                <input
                                  type="text"
                                  value={step.applicationFrequency}
                                  onChange={e => handleUpdateStepInRoutine(idx, 'applicationFrequency', e.target.value)}
                                  className="smart-input w-full text-xs py-1 px-2 text-slate-700 dark:text-luxe-200"
                                  placeholder="Frecuencia..."
                                />
                              </div>
                              <div>
                                <label className="text-[9px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider block">Indicación / Dosis</label>
                                <input
                                  type="text"
                                  value={step.dosageInstructions}
                                  onChange={e => handleUpdateStepInRoutine(idx, 'dosageInstructions', e.target.value)}
                                  className="smart-input w-full text-xs py-1 px-2 text-slate-700 dark:text-luxe-200"
                                  placeholder="Indicación..."
                                />
                              </div>
                            </div>

                            {/* Columna 3: Combobox Inteligente con Buscador y Eliminación */}
                            <div className="md:col-span-4 flex flex-col gap-1.5">
                              <div className="flex items-center justify-between">
                                <label className="text-[9px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Asociar Producto del Catálogo</label>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveStepFromCurrentRoutine(idx)}
                                  className="text-red-500 hover:text-red-650 p-1 rounded-md hover:bg-red-500/10 transition-colors"
                                  title="Eliminar este paso de la rutina"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>

                              <SmartCatalogSelector
                                stepName={step.stepName}
                                defaultProductName={step.defaultProductName}
                                selectedProductId={selectedVal}
                                products={products}
                                matches={matches}
                                biotype={patientForm.skinBiotype}
                                onSelect={(newProdId) => {
                                  setRoutineStepSelections(prev => ({
                                    ...prev,
                                    [selectionKey]: newProdId
                                  }));
                                }}
                              />
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>

                  <div className="pt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={applySelectedRoutineToPatient}
                      className="bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white px-8 py-3 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-2"
                    >
                      <Plus className="w-4.5 h-4.5" />
                      Cargar Rutina al Protocolo del Paciente
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Analytics Summary */}
            <div className="liquid-glass rounded-3xl p-8">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h2 className="font-sora text-xl font-bold text-slate-900 dark:text-white">Análisis de Biotipos en Consulta</h2>
                  <p className="text-slate-500 dark:text-luxe-300 text-xs mt-1">Distribución estadística en tiempo real de los biotipos de piel atendidos.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
                <div className="p-4 bg-slate-50 dark:bg-white/5 rounded-2xl border border-slate-200/50 dark:border-white/5">
                  <span className="block text-[8px] font-bold text-slate-400 uppercase tracking-widest">Total de Pacientes Valorados</span>
                  <span className="text-3xl font-extrabold font-sora text-slate-900 dark:text-white mt-1 block">{totalPatients}</span>
                </div>
                <div className="p-4 bg-slate-50 dark:bg-white/5 rounded-2xl border border-slate-200/50 dark:border-white/5">
                  <span className="block text-[8px] font-bold text-slate-400 uppercase tracking-widest">Biotipo Predominante</span>
                  <span className="text-xl font-bold text-bronze-600 dark:text-bronze-500 mt-1 block">{predominantBiotype}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: INVENTORY & CATALOG LAB */}
        {activeTab === 'inventory' && (
          <div className="space-y-8">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="font-outfit text-2xl font-bold text-slate-800 dark:text-white">Catálogo de Productos Dermoestéticos</h2>
                <p className="text-slate-500 dark:text-luxe-300 text-xs mt-1">Administración de fórmulas activas, precios profesionales y públicos.</p>
              </div>
              <button onClick={() => {
                setIsProductFormOpen(true);
                setIsEditProduct(false);
                setProductForm({ id: '', sku: '', name: '', brandLine: '', productType: '', retailPrice: '', isProfessionalUse: 1, activeIngredients: '[]', physiologicalActions: '[]', skinBiotypes: '[]', stockQuantity: '', costPrice: '', reorderPoint: '' });
                setFormIngredientsList([]);
              }} className="bg-gradient-to-r from-bronze-500 to-bronze-600 hover:brightness-110 text-white px-6 py-3 rounded-xl text-xs font-bold shadow-md transition-all flex items-center gap-1.5">
                <Plus className="w-4 h-4" /> Añadir Producto al Catálogo
              </button>
            </div>

            {/* Mutation Form Drawer */}
            {isProductFormOpen && (
              <div className="liquid-glass rounded-[32px] p-8 border border-slate-200/50 dark:border-white/5 shadow-2xl relative overflow-hidden transition-all duration-300">
                <h3 className="font-outfit text-lg font-bold text-slate-800 dark:text-white mb-6">
                  {isEditProduct ? 'Editar Producto' : 'Añadir Nuevo Producto al Catálogo'}
                </h3>
                
                <form onSubmit={handleSaveProduct} className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-5 gap-5 items-start">
                    {/* Position 1: Tipo / Formato */}
                    <SuggestField
                      label="Tipo de Producto / Formato *"
                      value={productForm.productType}
                      onChange={type => setProductForm(prev => ({ ...prev, productType: type }))}
                      options={allCapturedProductTypes}
                      placeholder="Ej: Gel limpiador, Suero, Fotoprotector..."
                      required
                      hint="Desplegable & Autocompletado"
                      emptyLabel="Tipos / Formatos Registrados"
                      addNewLabel="Agregar"
                    />

                    {/* Position 2: Nombre Comercial */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Nombre Comercial *</label>
                      <input type="text" value={productForm.name} onChange={e => setProductForm(prev => ({ ...prev, name: e.target.value }))} placeholder="Ej: Shampoo de Manzanilla..." required className="smart-input w-full font-semibold text-slate-800 dark:text-white" />
                    </div>

                    {/* Position 3: SKU/Código */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">SKU / Código *</label>
                      <input type="text" value={productForm.sku} onChange={e => setProductForm(prev => ({ ...prev, sku: e.target.value }))} placeholder="SKU..." required className="smart-input w-full font-mono" />
                    </div>

                    {/* Position 4: Marca/Línea */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Marca / Línea *</label>
                      <div ref={brandContainerRef} className="relative">
                        <input
                          type="text"
                          value={productForm.brandLine}
                          onChange={e => handleBrandSearch(e.target.value)}
                          onFocus={() => {
                            const q = productForm.brandLine.toLowerCase().trim();
                            const filtered = q
                              ? allCapturedBrands.filter(b => b.toLowerCase().includes(q)).slice(0, 8)
                              : allCapturedBrands.slice(0, 8);
                            setBrandSuggestions(filtered);
                            setShowBrandDropdown(true);
                          }}
                          onKeyDown={e => { if (e.key === 'Escape') setShowBrandDropdown(false); }}
                          placeholder="Marca/Línea..."
                          required
                          className="smart-input w-full"
                        />
                        {showBrandDropdown && brandSuggestions.length > 0 && (
                          <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-luxe-900 shadow-2xl max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5 animate-fade-in">
                            <div className="px-3 py-1.5 bg-slate-50 dark:bg-white/5 text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between sticky top-0 backdrop-blur-md z-10 border-b border-slate-100 dark:border-white/5">
                              <span>Marcas en BD ({brandSuggestions.length})</span>
                              <button
                                type="button"
                                onClick={() => setShowBrandDropdown(false)}
                                className="text-slate-400 hover:text-slate-600 dark:hover:text-white font-bold text-xs"
                              >
                                ✕
                              </button>
                            </div>
                            {brandSuggestions.map(b => (
                              <div
                                key={b}
                                onClick={() => {
                                  setProductForm(prev => ({ ...prev, brandLine: b }));
                                  setShowBrandDropdown(false);
                                }}
                                className="p-2.5 hover:bg-amber-500/10 dark:hover:bg-white/5 cursor-pointer text-xs transition-colors flex items-center justify-between group"
                              >
                                <span className="font-semibold text-slate-800 dark:text-white group-hover:text-amber-600 dark:group-hover:text-amber-400">
                                  {b}
                                </span>
                                <span className="text-[9px] bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full font-bold">
                                  Usar Marca
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Position 5: Precio Público */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Precio Público (MXN) *</label>
                      <input type="number" step="0.01" value={productForm.retailPrice} onChange={e => setProductForm(prev => ({ ...prev, retailPrice: e.target.value }))} placeholder="$0.00" required className="smart-input w-full font-semibold" />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Stock Actual</label>
                      <input type="number" step="1" min="0" value={productForm.stockQuantity} onChange={e => setProductForm(prev => ({ ...prev, stockQuantity: e.target.value }))} placeholder="Ej: 10" className="smart-input w-full" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Costo de Adquisición (MXN)</label>
                      <input type="number" step="0.01" min="0" value={productForm.costPrice} onChange={e => setProductForm(prev => ({ ...prev, costPrice: e.target.value }))} placeholder="$0.00" className="smart-input w-full" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Punto de Reorden</label>
                      <input type="number" step="1" min="0" value={productForm.reorderPoint} onChange={e => setProductForm(prev => ({ ...prev, reorderPoint: e.target.value }))} placeholder="Ej: 3" className="smart-input w-full" />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Tipo de Uso</label>
                      <select value={typeof productForm.isProfessionalUse === 'boolean' ? (productForm.isProfessionalUse ? 1 : 0) : productForm.isProfessionalUse} onChange={e => setProductForm(prev => ({ ...prev, isProfessionalUse: parseInt(e.target.value) }))} className="smart-input w-full px-4 py-3 rounded-xl text-sm">
                        <option value={1}>Uso en Cabina</option>
                        <option value={0}>Apoyo en Casa</option>
                        <option value={2}>Ambos (Cabina y Apoyo)</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Biotipo de Piel Recomendado</label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 bg-slate-500/5 p-3 rounded-xl border border-slate-200/20">
                        {['Piel Mixta', 'Piel Alípica', 'Piel Grasa', 'Piel Eudermica', 'Sensible', 'Rosácea', 'Todo tipo de piel', 'Protocolos específicos', 'Madura', 'Hipercromias', 'Deshidratada', 'Acneica', 'Delicada', 'Antiagning', 'Desvitalizada', 'Sensibilizada', 'Asfixiada'].map(bio => {
                          let currentBios: string[] = [];
                          try {
                            currentBios = JSON.parse(productForm.skinBiotypes || '[]');
                          } catch(e) {}
                          const isChecked = currentBios.includes(bio);
                          return (
                            <label key={bio} className="flex items-center gap-1.5 cursor-pointer text-[10px] font-medium text-slate-700 dark:text-luxe-200">
                              <input type="checkbox" checked={isChecked} onChange={() => {
                                let nextBios = [...currentBios];
                                if (isChecked) {
                                  nextBios = nextBios.filter(b => b !== bio);
                                } else {
                                  nextBios.push(bio);
                                }
                                setProductForm(prev => ({ ...prev, skinBiotypes: JSON.stringify(nextBios) }));
                              }} className="rounded border-slate-350 w-3.5 h-3.5" />
                              <span>{bio}</span>
                            </label>
                          );
                        })}
                      </div>

                      {/* Rubro libre para biotipo de piel personalizado */}
                      {(() => {
                        let currentBios: string[] = [];
                        try {
                          currentBios = JSON.parse(productForm.skinBiotypes || '[]');
                        } catch(e) {}
                        const presets = ['Piel Mixta', 'Piel Alípica', 'Piel Grasa', 'Piel Eudermica', 'Sensible', 'Rosácea', 'Todo tipo de piel', 'Protocolos específicos', 'Madura', 'Hipercromias', 'Deshidratada', 'Acneica', 'Delicada', 'Antiagning', 'Desvitalizada', 'Sensibilizada', 'Asfixiada'];
                        const customBios = currentBios.filter(b => !presets.includes(b)).join(', ');

                        return (
                          <div className="flex flex-col gap-1 mt-1">
                            <label className="text-[9px] font-semibold text-slate-400 dark:text-luxe-400">Biotipo / Indicación Adicional Personalizada (Manual):</label>
                            <input
                              type="text"
                              value={customBios}
                              onChange={e => {
                                const val = e.target.value;
                                const customArray = val.split(',').map(s => s.trim()).filter(Boolean);
                                const selectedPresets = currentBios.filter(b => presets.includes(b));
                                const nextBios = Array.from(new Set([...selectedPresets, ...customArray]));
                                setProductForm(prev => ({ ...prev, skinBiotypes: JSON.stringify(nextBios) }));
                              }}
                              placeholder="Ej: Rosácea Grasa, Sensible reactiva..."
                              className="smart-input w-full text-xs"
                            />
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Formulation Lab Integration */}
                  <div className="border border-slate-200/50 dark:border-white/5 bg-slate-500/5 p-6 rounded-2xl space-y-4">
                    <h4 className="font-outfit text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                      <Beaker className="w-4 h-4 text-bronze-500" /> Laboratorio de Activos y Formulación
                    </h4>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                      <div ref={ingredientContainerRef} className="md:col-span-4 flex flex-col gap-1.5 relative">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Ingrediente Activo</label>
                        <input
                          type="text"
                          value={formIngredientInput}
                          onChange={e => handleProductIngredientSearch(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Escape') setIngredientSuggestions([]); }}
                          placeholder="Ej: Centella..."
                          className="smart-input w-full"
                        />
                        {ingredientSuggestions.length > 0 && (
                          <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-luxe-900 shadow-xl max-h-40 overflow-y-auto">
                            {ingredientSuggestions.map(ing => (
                              <div key={ing.name} onClick={() => selectFormIngredient(ing.name, ing.action)} className="p-2.5 hover:bg-slate-100 dark:hover:bg-white/5 border-b border-slate-100 dark:border-white/5 last:border-0 cursor-pointer text-xs">
                                <span className="font-bold text-slate-800 dark:text-white">{ing.name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div ref={actionContainerRef} className="md:col-span-6 flex flex-col gap-1.5 relative">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Acción / Efecto Clínico de este Activo</label>
                        <input
                          type="text"
                          value={formIngredientAction}
                          onChange={e => handleProductActionSearch(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Escape') setShowActionDropdown(false); }}
                          onFocus={() => {
                            const queryLower = formIngredientAction.toLowerCase().trim();
                            const filtered = queryLower
                              ? allCapturedActions.filter(act => act.toLowerCase().includes(queryLower)).slice(0, 8)
                              : allCapturedActions.slice(0, 8);
                            setActionSuggestions(filtered);
                            setShowActionDropdown(true);
                          }}
                          placeholder="Ej: Estimula colágeno, Hidratante, Calmante..."
                          className="smart-input w-full"
                        />

                        {showActionDropdown && actionSuggestions.length > 0 && (
                          <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-luxe-900 shadow-2xl max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5 animate-fade-in">
                            <div className="px-3 py-1.5 bg-slate-50 dark:bg-white/5 text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between sticky top-0 backdrop-blur-md z-10 border-b border-slate-100 dark:border-white/5">
                              <span>Efectos Clínicos Capturados en la BD ({actionSuggestions.length})</span>
                              <button
                                type="button"
                                onClick={() => setShowActionDropdown(false)}
                                className="text-slate-400 hover:text-slate-600 dark:hover:text-white font-bold text-xs"
                              >
                                ✕
                              </button>
                            </div>
                            {actionSuggestions.map(actionText => (
                              <div
                                key={actionText}
                                onClick={() => selectFormAction(actionText)}
                                className="p-2.5 hover:bg-amber-500/10 dark:hover:bg-white/5 cursor-pointer text-xs transition-colors flex items-center justify-between group"
                              >
                                <span className="font-semibold text-slate-800 dark:text-white group-hover:text-amber-600 dark:group-hover:text-amber-400">
                                  {actionText}
                                </span>
                                <span className="text-[9px] bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full font-bold">
                                  Usar Efecto
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="md:col-span-2">
                        <button type="button" onClick={handleAddIngredientToForm} className="bg-gradient-to-r from-bronze-500 to-bronze-600 text-white w-full py-2.5 rounded-xl text-xs font-bold shadow transition-all hover:brightness-110">
                          Ligar Activo
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 min-h-[50px] items-center border border-dashed border-slate-200/50 p-3 rounded-xl bg-white/10">
                      {formIngredientsList.length === 0 ? (
                        <div className="text-xs text-slate-400 italic">No se han añadido activos.</div>
                      ) : (
                        formIngredientsList.map((ing, idx) => (
                          <div key={idx} className="flex items-center gap-1.5 px-3 py-1 rounded-xl border border-bronze-500/20 bg-bronze-500/5 text-bronze-600 dark:text-bronze-400 text-xs font-medium">
                            <button type="button" onClick={() => editIngredientInForm(idx)} title="Editar ingrediente y acción/efecto" className="hover:underline text-left">
                              {ing.name}{ing.action ? ` (${ing.action})` : ''}
                            </button>
                            <button type="button" onClick={() => removeIngredientFromForm(idx)} className="p-0.5 hover:text-red-500 transition-colors ml-1 font-bold">✕</button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="flex justify-end gap-3 pt-4 border-t border-slate-200/50 dark:border-white/5">
                    <button type="button" onClick={() => setIsProductFormOpen(false)} className="px-5 py-2.5 rounded-xl text-slate-500 dark:text-luxe-300 hover:bg-slate-100">Cancelar</button>
                    <button type="submit" className="bg-gradient-to-r from-bronze-500 to-bronze-600 text-white px-6 py-2.5 rounded-xl text-xs font-bold tracking-wide shadow-md">Guardar en Catálogo</button>
                  </div>
                </form>
              </div>
            )}

            {/* Alerta de Stock Bajo */}
            {lowStockProducts.length > 0 && (
              <div className="liquid-glass rounded-3xl p-6 border border-red-500/20 bg-red-500/5">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className="w-5 h-5 text-red-500" />
                  <h3 className="font-outfit text-sm font-bold text-slate-800 dark:text-white">
                    {lowStockProducts.length} producto{lowStockProducts.length !== 1 ? 's' : ''} con stock bajo
                  </h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  {lowStockProducts.map(p => (
                    <span key={p.id} className="px-3 py-1.5 rounded-xl bg-white dark:bg-luxe-900 border border-red-500/20 text-xs font-medium text-slate-700 dark:text-luxe-200">
                      {p.name} <span className="text-red-600 dark:text-red-400 font-bold">({p.stockQuantity} / mín. {p.reorderPoint})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Catalog Items Table */}
            <div className="liquid-glass rounded-3xl p-8">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-6">
                <input type="text" value={catalogSearch} onChange={e => setCatalogSearch(e.target.value)} placeholder="🔍 Buscar por nombre o activos..." className="smart-input w-full md:max-w-md pl-10 pr-4 py-3 rounded-xl text-xs" />
              </div>

              <div className="border border-slate-200/50 dark:border-white/5 rounded-2xl bg-white/20 dark:bg-luxe-950/20 max-h-[500px] overflow-y-auto overflow-x-auto relative">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-luxe-900 border-b border-slate-200/50 dark:border-white/5 shadow-sm">
                    <tr>
                      <th className="py-3.5 px-4 font-bold">SKU</th>
                      <th className="py-3.5 px-4 font-bold">Producto</th>
                      <th className="py-3.5 px-4 font-bold">Tipo / Formato</th>
                      <th className="py-3.5 px-4 font-bold">Marca</th>
                      <th className="py-3.5 px-4 font-bold">Precio</th>
                      <th className="py-3.5 px-4 font-bold">Stock</th>
                      <th className="py-3.5 px-4 font-bold">Activos</th>
                      <th className="py-3.5 px-4 font-bold">Uso</th>
                      <th className="py-3.5 px-4 font-bold">Biotipos</th>
                      <th className="py-3.5 px-4 text-right font-bold">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                    {memoizedFilteredProducts.map(p => {
                        let parsedActives = '';
                        try {
                          parsedActives = JSON.parse(p.activeIngredients).join(', ');
                        } catch(e) {
                          parsedActives = p.activeIngredients;
                        }
                        let bios: string[] = [];
                        try {
                          bios = JSON.parse(p.skinBiotypes || '[]');
                        } catch(e) {}
                        const displayType = p.productType || inferProductType(p.name, p.brandLine);
                        return (
                          <tr key={p.id}>
                            <td className="py-3.5 px-4 font-mono text-[11px] text-slate-500 dark:text-luxe-400">{p.sku}</td>
                            <td className="py-3.5 px-4 font-bold">{p.name}</td>
                            <td className="py-3.5 px-4">
                              <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[10px] font-semibold">
                                {displayType}
                              </span>
                            </td>
                            <td className="py-3.5 px-4">{p.brandLine}</td>
                            <td className="py-3.5 px-4">${p.retailPrice.toFixed(2)} MXN</td>
                            <td className="py-3.5 px-4">
                              {p.stockQuantity === undefined || p.stockQuantity === null ? (
                                <span className="text-[10px] text-slate-400 italic">—</span>
                              ) : (
                                <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                                  p.reorderPoint !== undefined && p.reorderPoint !== null && p.stockQuantity <= p.reorderPoint
                                    ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                                    : 'bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-luxe-300'
                                }`} title={p.reorderPoint !== undefined && p.reorderPoint !== null ? `Punto de reorden: ${p.reorderPoint}` : undefined}>
                                  {p.reorderPoint !== undefined && p.reorderPoint !== null && p.stockQuantity <= p.reorderPoint ? '⚠️ ' : ''}{p.stockQuantity}
                                </span>
                              )}
                            </td>
                            <td className="py-3.5 px-4 truncate max-w-[150px]">{parsedActives}</td>
                            <td className="py-3.5 px-4">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                                p.isProfessionalUse === 2 || p.isProfessionalUse === '2' ? 'bg-blue-100 text-blue-700' :
                                (p.isProfessionalUse === 1 || p.isProfessionalUse === true || p.isProfessionalUse === '1' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700')
                              }`}>
                                {p.isProfessionalUse === 2 || p.isProfessionalUse === '2' ? 'Ambos' :
                                 (p.isProfessionalUse === 1 || p.isProfessionalUse === true || p.isProfessionalUse === '1' ? 'Cabina' : 'Apoyo Casa')}
                              </span>
                            </td>
                            <td className="py-3.5 px-4 flex flex-wrap gap-1 max-w-[180px]">
                              {bios.length === 0 ? (
                                <span className="text-[9px] text-slate-400 italic">Todos</span>
                              ) : (
                                bios.map(b => (
                                  <span key={b} className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/5 text-[9px] font-medium text-slate-600 dark:text-luxe-300">
                                    {b.split(' ')[0]}
                                  </span>
                                ))
                              )}
                            </td>
                            <td className="py-3.5 px-4 text-right space-x-2">
                              <button onClick={() => handleEditProductClick(p)} className="text-blue-600 dark:text-blue-400 hover:underline" title="Editar Producto">
                                <Edit className="w-4 h-4 inline" />
                              </button>
                              <button onClick={() => handleDeleteProduct(p.id)} className="text-red-600 dark:text-red-400 hover:underline" title="Eliminar Producto">
                                <Trash2 className="w-4 h-4 inline" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Catálogo Alfabético de Activos */}
            <div className="liquid-glass rounded-3xl p-8">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-6">
                <h2 className="font-outfit text-xl font-bold text-slate-800 dark:text-white flex items-center gap-2">
                  <Beaker className="w-5 h-5 text-bronze-500" /> Catálogo de Activos (A-Z)
                </h2>
                <span className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest whitespace-nowrap">
                  {filteredIngredientsCatalog.length} de {alphabeticalIngredientsCatalog.length} activos únicos
                </span>
              </div>

              <input
                type="text"
                value={activosCatalogSearch}
                onChange={e => setActivosCatalogSearch(e.target.value)}
                placeholder="🔍 Buscar por nombre o acción/efecto..."
                className="smart-input w-full md:max-w-md pl-4 pr-4 py-3 rounded-xl text-xs mb-4"
              />

              <div className="border border-slate-200/50 dark:border-white/5 rounded-2xl bg-white/20 dark:bg-luxe-950/20 max-h-[400px] overflow-y-auto">
                {filteredIngredientsCatalog.length === 0 ? (
                  <div className="p-6 text-xs text-slate-400 italic text-center">
                    {alphabeticalIngredientsCatalog.length === 0 ? 'No hay activos capturados todavía.' : 'Ningún activo coincide con la búsqueda.'}
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-luxe-900 border-b border-slate-200/50 dark:border-white/5 shadow-sm">
                      <tr>
                        <th className="py-3 px-4 font-bold">Activo</th>
                        <th className="py-3 px-4 font-bold">Acción / Efecto Clínico</th>
                        <th className="py-3 px-4 text-right font-bold">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                      {filteredIngredientsCatalog.map(ing => {
                        const isEditing = editingCatalogIngredient === ing.name;
                        return (
                          <tr key={ing.name}>
                            {isEditing ? (
                              <>
                                <td className="py-2 px-4">
                                  <input type="text" value={editCatalogNameDraft} onChange={e => setEditCatalogNameDraft(e.target.value)} className="smart-input w-full text-xs" autoFocus />
                                </td>
                                <td className="py-2 px-4">
                                  <input type="text" value={editCatalogActionDraft} onChange={e => setEditCatalogActionDraft(e.target.value)} className="smart-input w-full text-xs" />
                                </td>
                                <td className="py-2 px-4 text-right space-x-2 whitespace-nowrap">
                                  <button onClick={() => handleEditCatalogIngredient(ing.name, editCatalogNameDraft, editCatalogActionDraft)} className="text-green-600 dark:text-green-400 hover:underline font-bold" title="Guardar cambios">
                                    Guardar
                                  </button>
                                  <button onClick={() => setEditingCatalogIngredient(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-white" title="Cancelar">
                                    Cancelar
                                  </button>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="py-2.5 px-4 font-bold text-slate-800 dark:text-white">{ing.name}</td>
                                <td className="py-2.5 px-4 text-slate-500 dark:text-luxe-300">{ing.action}</td>
                                <td className="py-2.5 px-4 text-right space-x-2">
                                  <button
                                    onClick={() => {
                                      setEditingCatalogIngredient(ing.name);
                                      setEditCatalogNameDraft(ing.name);
                                      setEditCatalogActionDraft(ing.action);
                                    }}
                                    className="text-blue-600 dark:text-blue-400 hover:underline"
                                    title="Editar activo en todos los productos"
                                  >
                                    <Edit className="w-4 h-4 inline" />
                                  </button>
                                  <button onClick={() => handleDeleteCatalogIngredient(ing.name)} className="text-red-600 dark:text-red-400 hover:underline" title="Eliminar activo de todos los productos">
                                    <Trash2 className="w-4 h-4 inline" />
                                  </button>
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Bulk File upload */}
            <div className="liquid-glass rounded-3xl p-8">
              <h2 className="font-outfit text-xl font-bold text-slate-800 dark:text-white mb-2">Importación de Catálogo</h2>
              <p className="text-slate-500 dark:text-luxe-300 text-xs mb-6">Arrastra y suelta tu archivo Excel o PDF del catálogo para actualizar masivamente el inventario.</p>

              <div className="border-2 border-dashed border-slate-300 dark:border-white/10 hover:border-bronze-500/50 rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer bg-slate-50/50 dark:bg-white/[0.01] hover:bg-bronze-500/[0.02] relative">
                <input type="file" accept=".xlsx, .xls, .pdf" onChange={handleExcelUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                <FileUp className="w-10 h-10 text-bronze-500 mb-4" />
                <p className="text-xs font-semibold">Selecciona o arrastra tu archivo Excel (.xlsx, .xls) o PDF (.pdf)</p>
              </div>

              {uploadPreview.length > 0 && (() => {
                const includedCount = uploadPreview.filter(p => !uploadPreviewExcludedIds[p.id]).length;
                return (
                  <div className="mt-6 space-y-3">
                    <div className="flex flex-wrap justify-between items-center gap-3">
                      <span className="text-xs font-bold text-slate-400">
                        {includedCount} de {uploadPreview.length} productos se importarán — revisa y corrige cada fila antes de confirmar.
                      </span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => { setUploadPreview([]); setUploadPreviewExcludedIds({}); }}
                          className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-200 hover:bg-slate-300 dark:bg-white/10 dark:hover:bg-white/20 text-slate-700 dark:text-luxe-200"
                        >
                          Cancelar
                        </button>
                        <button
                          onClick={confirmBulkImport}
                          disabled={includedCount === 0}
                          className="bg-gradient-to-r from-bronze-500 to-bronze-600 text-white px-6 py-2 rounded-xl text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Confirmar e Importar {includedCount} Productos
                        </button>
                      </div>
                    </div>

                    <div className="border border-slate-200/50 dark:border-white/10 rounded-2xl overflow-hidden">
                      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-slate-50 dark:bg-luxe-900 z-10">
                            <tr className="text-left text-[9px] uppercase tracking-wider text-slate-400 border-b border-slate-200/50 dark:border-white/10">
                              <th className="p-2 w-8"></th>
                              <th className="p-2 min-w-[160px]">Nombre</th>
                              <th className="p-2 min-w-[110px]">Marca</th>
                              <th className="p-2 min-w-[100px]">Tipo</th>
                              <th className="p-2 min-w-[90px]">Precio</th>
                              <th className="p-2 min-w-[160px]">Activos Clave</th>
                              <th className="p-2 min-w-[130px]">Biotipo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {uploadPreview.map(p => {
                              const excluded = !!uploadPreviewExcludedIds[p.id];
                              let actives = '';
                              try { actives = parseStringList(p.activeIngredients).join(', '); } catch(e) {}
                              let biotypes = '';
                              try { biotypes = parseStringList(p.skinBiotypes).join(', '); } catch(e) {}
                              return (
                                <tr key={p.id} className={`border-b border-slate-100 dark:border-white/5 last:border-0 ${excluded ? 'opacity-40' : ''}`}>
                                  <td className="p-2 align-top">
                                    <input
                                      type="checkbox"
                                      checked={!excluded}
                                      onChange={() => toggleUploadPreviewExclusion(p.id)}
                                      title={excluded ? 'Excluido de la importación (ya existe en catálogo)' : 'Se importará'}
                                      className="w-3.5 h-3.5 rounded accent-bronze-500"
                                    />
                                  </td>
                                  <td className="p-1.5 align-top">
                                    <input type="text" value={p.name} onChange={e => updateUploadPreviewRow(p.id, { name: e.target.value })} className="w-full bg-transparent border border-transparent hover:border-slate-200 dark:hover:border-white/10 focus:border-amber-500 rounded-md px-1.5 py-1 text-xs font-semibold" />
                                    {excluded && <span className="text-[9px] text-amber-600 dark:text-amber-400 font-bold ml-1.5">Ya existe</span>}
                                  </td>
                                  <td className="p-1.5 align-top">
                                    <input type="text" value={p.brandLine} onChange={e => updateUploadPreviewRow(p.id, { brandLine: e.target.value })} className="w-full bg-transparent border border-transparent hover:border-slate-200 dark:hover:border-white/10 focus:border-amber-500 rounded-md px-1.5 py-1 text-xs" />
                                  </td>
                                  <td className="p-1.5 align-top">
                                    <input type="text" value={p.productType || ''} onChange={e => updateUploadPreviewRow(p.id, { productType: e.target.value })} className="w-full bg-transparent border border-transparent hover:border-slate-200 dark:hover:border-white/10 focus:border-amber-500 rounded-md px-1.5 py-1 text-xs" />
                                  </td>
                                  <td className="p-1.5 align-top">
                                    <input type="number" step="0.01" value={p.retailPrice} onChange={e => updateUploadPreviewRow(p.id, { retailPrice: parseFloat(e.target.value) || 0 })} className="w-full bg-transparent border border-transparent hover:border-slate-200 dark:hover:border-white/10 focus:border-amber-500 rounded-md px-1.5 py-1 text-xs" />
                                  </td>
                                  <td className="p-1.5 align-top">
                                    <input type="text" value={actives} onChange={e => updateUploadPreviewRow(p.id, { activeIngredients: JSON.stringify(e.target.value.split(',').map(s => s.trim()).filter(Boolean)) })} className="w-full bg-transparent border border-transparent hover:border-slate-200 dark:hover:border-white/10 focus:border-amber-500 rounded-md px-1.5 py-1 text-xs" />
                                  </td>
                                  <td className="p-1.5 align-top">
                                    <input type="text" value={biotypes} onChange={e => updateUploadPreviewRow(p.id, { skinBiotypes: JSON.stringify(e.target.value.split(',').map(s => s.trim()).filter(Boolean)) })} className="w-full bg-transparent border border-transparent hover:border-slate-200 dark:hover:border-white/10 focus:border-amber-500 rounded-md px-1.5 py-1 text-xs" />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Professional Cosmetology Brands Resource Center */}
            <div className="liquid-glass rounded-3xl p-8 border border-slate-200/50 dark:border-white/5 space-y-6">
              <div>
                <h3 className="font-outfit text-lg font-bold text-slate-800 dark:text-white flex items-center gap-2">
                  <Beaker className="w-5 h-5 text-bronze-500" />
                  Centro de Recursos de Cosmetología Profesional
                </h3>
                <p className="text-slate-500 dark:text-luxe-300 text-xs mt-1">
                  Enlaces oficiales e informativos de laboratorios dermoestéticos líderes para la consulta de activos y protocolos clínicos.
                </p>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                {[
                  { name: 'Miguett', url: 'https://miguett.com/collections/todos-los-productos', desc: 'Fórmulas mexicanas de alta vanguardia cosmetológica.' },
                  { name: 'Casmara', url: 'https://www.casmara.com/es/productos/', desc: 'Tratamientos profesionales de alta cosmética y máscaras de alginato.' },
                  { name: 'Germaine de Capuccini', url: 'https://germainedecapuccini.es/tienda/', desc: 'Cuidado de la piel profesional con laboratorios de nivel médico.' },
                  { name: 'Mesoestetic', url: 'https://www.mesoestetic.com/es/cuidado-de-la-piel', desc: 'Tratamientos de medicina estética y cosmecéuticos de grado clínico.' },
                  { name: 'Skeyndor', url: 'https://skeyndor.com/es/productos.html', desc: 'Líder en cosmética científica con activos patentados.' },
                  { name: 'Lidherma', url: 'https://www.lidherma.com/productos', desc: 'Productos de calidad médica para profesionales de la estética.' }
                ].map(brand => (
                  <div
                    key={brand.name}
                    onClick={() => {
                      setCatalogSearch(brand.name);
                      setActiveTab('inventory');
                      showToastMsg('Mostrando catálogo de ' + brand.name + ' en inventario.', 'success');
                    }}
                    className="p-4 bg-white/40 dark:bg-luxe-950/20 border border-slate-200/50 dark:border-white/5 rounded-2xl flex flex-col justify-between hover:border-bronze-500/50 hover:shadow-lg transition-all duration-300 group cursor-pointer"
                  >
                    <div>
                      <span className="block text-xs font-bold text-slate-800 dark:text-white group-hover:text-bronze-500 transition-colors">
                        {brand.name}
                      </span>
                      <p className="text-[10px] text-slate-500 dark:text-luxe-300 mt-1 leading-normal">
                        {brand.desc}
                      </p>
                    </div>
                    <div className="flex items-center justify-between mt-3 flex-wrap gap-1">
                      <a
                        href={brand.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-[9px] font-bold text-bronze-500 hover:underline"
                      >
                        Sitio Oficial ↗
                      </a>
                      <span className="text-[9px] font-bold text-slate-400 dark:text-luxe-400 group-hover:text-bronze-500 transition-colors">
                        Ver Catálogo →
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: RECORDS HISTORY */}
        {activeTab === 'records' && (
          <div className="space-y-8 animate-fade-in">
            {/* Header and Stats */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="font-outfit text-2xl font-bold text-slate-800 dark:text-white flex items-center gap-2">
                  <FolderHeart className="w-6 h-6 text-bronze-500" />
                  Archivo de Expedientes Clínicos
                </h2>
                <p className="text-slate-500 dark:text-luxe-300 text-xs mt-1">
                  Carpetas clínicas digitales organizadas por paciente. Administra múltiples visitas y recetas.
                </p>
              </div>
              <div className="flex items-center gap-2 bg-slate-100/80 dark:bg-white/5 px-4 py-2 rounded-2xl border border-slate-200/50 dark:border-white/5">
                <span className="text-xs text-slate-400 font-bold uppercase tracking-wider">Total Pacientes:</span>
                <span className="text-sm font-extrabold text-bronze-600 dark:text-bronze-400">{patients.length}</span>
              </div>
            </div>

            {/* Filter and Search Bar */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-slate-50/50 dark:bg-white/5 p-4 rounded-3xl border border-slate-200/50 dark:border-white/5">
              <div className="relative">
                <Search className="absolute left-3.5 top-3.5 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Buscar paciente por nombre o teléfono..."
                  value={folderSearchQuery}
                  onChange={e => setFolderSearchQuery(e.target.value)}
                  className="smart-input w-full pl-10"
                />
              </div>

              <div>
                <select
                  value={folderBiotypeFilter}
                  onChange={e => setFolderBiotypeFilter(e.target.value)}
                  className="smart-input w-full"
                >
                  <option value="">-- Todos los Biotipos --</option>
                  <option value="Seca">Piel Seca</option>
                  <option value="Mixta">Piel Mixta</option>
                  <option value="Grasa">Piel Grasa</option>
                  <option value="Eudérmica / Normal">Piel Normal / Eudérmica</option>
                </select>
              </div>

              <div className="flex items-center justify-end">
                <button
                  onClick={() => {
                    setFolderSearchQuery('');
                    setFolderBiotypeFilter('');
                  }}
                  className="text-xs font-bold text-bronze-600 dark:text-bronze-400 hover:underline"
                >
                  Restablecer Filtros
                </button>
              </div>
            </div>

            {/* Patients Folders Grid */}
            <div className="space-y-4">
              {(() => {
                const groupedRecords = memoizedGroupedRecords;
                const filteredPatients = memoizedFilteredPatients;

                if (filteredPatients.length === 0) {
                  return (
                    <div className="text-center py-12 liquid-glass rounded-3xl border border-slate-200/50 dark:border-white/5">
                      <FolderHeart className="w-12 h-12 text-slate-350 dark:text-slate-600 mx-auto mb-3" />
                      <p className="text-slate-400 italic text-xs">No se encontraron carpetas de pacientes con los filtros aplicados.</p>
                    </div>
                  );
                }

                return filteredPatients.map(pat => {
                  const patConsultations = (groupedRecords[pat.id] || []).sort(
                    (a, b) => new Date(b.visitDate).getTime() - new Date(a.visitDate).getTime()
                  );
                  const isExpanded = !!expandedPatientFolders[pat.id];
                  const latestConsultation = patConsultations[0];

                  // Calculate Age
                  let ageStr = 'N/A';
                  if (pat.dateOfBirth) {
                    const birthDate = new Date(pat.dateOfBirth);
                    const today = new Date();
                    let age = today.getFullYear() - birthDate.getFullYear();
                    const m = today.getMonth() - birthDate.getMonth();
                    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
                      age--;
                    }
                    ageStr = `${age} años`;
                  }

                  return (
                    <div
                      key={pat.id}
                      className={`liquid-glass rounded-3xl border border-slate-200/50 dark:border-white/5 transition-all duration-300 overflow-hidden shadow-sm hover:shadow-md ${
                        isExpanded ? 'ring-2 ring-bronze-500/20 bg-white/60 dark:bg-luxe-950/20' : ''
                      }`}
                    >
                      {/* Folder Row Summary Header */}
                      <div
                        onClick={() =>
                          setExpandedPatientFolders(prev => ({
                            ...prev,
                            [pat.id]: !prev[pat.id]
                          }))
                        }
                        className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 cursor-pointer hover:bg-slate-500/5 transition-colors select-none"
                      >
                        <div className="flex items-center gap-4">
                          <div className={`p-3 rounded-2xl transition-transform ${isExpanded ? 'bg-bronze-500/10 text-bronze-500 scale-110' : 'bg-slate-100 dark:bg-white/5 text-slate-400'}`}>
                            <FolderHeart className="w-6 h-6" />
                          </div>
                          <div>
                            <h3 className="font-outfit text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
                              {pat.firstNameEncrypted} {pat.lastNameEncrypted}
                              <span className="text-[9px] bg-slate-100 dark:bg-white/5 px-2 py-0.5 rounded-full font-bold text-slate-400 tracking-wider">
                                {pat.id}
                              </span>
                            </h3>
                            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-[11px] text-slate-500 dark:text-luxe-300">
                              <span>📅 Nacimiento: <strong>{pat.dateOfBirth}</strong> ({ageStr})</span>
                              <span>📞 Cel: {pat.phoneEncrypted}</span>
                              {latestConsultation && (
                                <span className="text-bronze-600 dark:text-bronze-400">⚡ Biotipo Reciente: <strong>{latestConsultation.skinBiotype}</strong></span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4">
                          <div className="text-right hidden sm:block">
                            <span className="block text-[9px] font-bold text-slate-400 uppercase tracking-wider">Sesiones Guardadas</span>
                            <span className="text-sm font-extrabold text-slate-800 dark:text-white">{patConsultations.length} visitas</span>
                          </div>
                          <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform duration-300 ${isExpanded ? 'rotate-180 text-bronze-500' : ''}`} />
                        </div>
                      </div>

                      {/* Folder Content (Visits and Demographics details) */}
                      {isExpanded && (
                        <div className="border-t border-slate-200/50 dark:border-white/5 bg-slate-500/[0.02] p-6 space-y-6 animate-slide-up">
                          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                            
                            {/* Left panel: Anamnesis / Demographics */}
                            <div className="lg:col-span-1 bg-white/40 dark:bg-luxe-950/20 p-4 rounded-2xl border border-slate-200/50 dark:border-white/5 space-y-4">
                              <h4 className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest flex items-center gap-1">
                                <Clipboard className="w-3.5 h-3.5 text-bronze-500" />
                                Historial de Admisión
                              </h4>
                              
                              <div className="space-y-3 text-xs">
                                <div>
                                  <span className="block text-[9px] text-slate-400 uppercase">Edad actual</span>
                                  <span className="font-semibold text-slate-700 dark:text-luxe-100">{ageStr} ({pat.dateOfBirth})</span>
                                </div>
                                <div>
                                  <span className="block text-[9px] text-slate-400 uppercase">Teléfono de contacto</span>
                                  <span className="font-semibold text-slate-700 dark:text-luxe-100">{pat.phoneEncrypted}</span>
                                </div>
                                <div>
                                  <span className="block text-[9px] text-slate-400 uppercase">Identificador</span>
                                  <span className="font-mono text-[10px] text-slate-500 dark:text-luxe-300">{pat.id}</span>
                                </div>
                                <div className="pt-2 border-t border-slate-200/50 dark:border-white/5">
                                  <span className="block text-[9px] text-slate-400 uppercase">Alergias Clínicas/Cosméticos</span>
                                  <span className="text-[11px] font-medium text-red-500">
                                    {latestConsultation?.allergies || 'Ninguna registrada'}
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-[9px] text-slate-400 uppercase">Condiciones Médicas/Procedimientos Qx</span>
                                  <span className="text-[11px] font-medium text-slate-700 dark:text-luxe-100">
                                    {latestConsultation?.medicalConditions || 'Ninguna registrada'}
                                  </span>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() => handleSelectPatient(pat.id)}
                                className="w-full bg-gradient-to-r from-bronze-500 to-bronze-600 hover:brightness-110 text-white py-2 rounded-xl text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 shadow-sm"
                              >
                                <Plus className="w-3.5 h-3.5" /> Nueva Consulta / Visita
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeletePatient(pat.id)}
                                className="w-full bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 py-2 rounded-xl text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 mt-2 border border-red-500/20"
                                title="Eliminar Expediente Completo"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> Eliminar Expediente Clínico
                              </button>
                            </div>

                            {/* Right panel: Visits chronology */}
                            <div className="lg:col-span-3 space-y-4">
                              <h4 className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest flex items-center gap-1">
                                <Clock className="w-3.5 h-3.5 text-bronze-500" />
                                Historial de Visitas y Hojas Clínicas ({patConsultations.length})
                              </h4>

                              <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2">
                                {patConsultations.map(consultation => (
                                  <div
                                    key={consultation.id}
                                    className="bg-white/60 dark:bg-luxe-950/40 p-4 rounded-2xl border border-slate-200/50 dark:border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-slate-300 dark:hover:border-white/10 transition-colors"
                                  >
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-2">
                                        <span className="font-outfit text-xs font-bold text-slate-800 dark:text-white">
                                          Sesión del {new Date(consultation.visitDate).toLocaleDateString()}
                                        </span>
                                        <span className="px-2 py-0.5 rounded-full text-[8px] font-bold uppercase bg-amber-500/10 text-amber-500">
                                          {consultation.state}
                                        </span>
                                        <span className="text-[10px] text-slate-400 font-mono">({consultation.id})</span>
                                      </div>
                                      <div className="flex gap-4 text-[11px] text-slate-500 dark:text-luxe-300">
                                        <span>Biotipo: <strong className="text-bronze-600 dark:text-bronze-400">{consultation.skinBiotype}</strong></span>
                                        <span>Protocolo: <strong>{consultation.medicalDiagnosis || 'Sin protocolo'}</strong></span>
                                      </div>
                                      <p className="text-[11px] text-slate-500 dark:text-luxe-400 line-clamp-1 italic">
                                        SOAP: {consultation.clinicalNotes}
                                      </p>
                                    </div>

                                    {/* Action Buttons per Visit */}
                                    <div className="flex items-center gap-2 self-end md:self-auto">
                                      <button
                                        onClick={() => triggerPdfDownload('ficha', pat, consultation)}
                                        className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 text-slate-600 dark:text-luxe-300 transition-colors"
                                        title="Descargar Ficha Técnica PDF"
                                      >
                                        <FileText className="w-4 h-4" />
                                      </button>
                                      <button
                                        onClick={() => triggerPdfDownload('receta', pat, consultation)}
                                        className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/5 dark:hover:bg-white/10 text-slate-600 dark:text-luxe-300 transition-colors"
                                        title="Descargar Receta de Apoyo en Casa PDF"
                                      >
                                        <FileUp className="w-4 h-4 rotate-180" />
                                      </button>
                                      <button
                                        onClick={() => handleEditConsultation(consultation)}
                                        className="p-2 rounded-xl bg-bronze-500/10 text-bronze-600 dark:text-bronze-400 hover:bg-bronze-500/20 transition-colors"
                                        title="Cargar / Editar en el Generador"
                                      >
                                        <Edit className="w-4 h-4" />
                                      </button>
                                      <button
                                        onClick={() => handleDeleteConsultation(consultation.id, pat.id)}
                                        className="p-2 rounded-xl bg-red-500/10 text-red-650 hover:bg-red-500/20 transition-colors"
                                        title="Eliminar esta consulta"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                          </div>
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </main>

      {/* Barra fija de Guardar/Cancelar: visible en todo momento (sin importar el scroll) mientras se
          edita una consulta ya guardada, para que quede claro cómo confirmar o descartar la edición. */}
      {activeTab === 'generator' && activeConsultationId && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-luxe-900/95 backdrop-blur-md border-t border-slate-200/50 dark:border-white/5 shadow-[0_-4px_20px_rgba(0,0,0,0.12)] animate-slide-up">
          <div className="max-w-7xl mx-auto px-6 py-3 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-luxe-200">
              <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
              <span className="font-semibold">
                Editando a <span className="text-amber-600 dark:text-amber-400">{`${patientForm.firstName} ${patientForm.lastName}`.trim() || 'paciente'}</span>
                <span className="hidden sm:inline text-slate-400 dark:text-luxe-400 font-mono font-normal"> · {activeConsultationId}</span>
              </span>
            </div>
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <button
                type="button"
                onClick={() => {
                  setActiveConsultationId('');
                  resetPatientForm();
                  showToastMsg('Edición cancelada.', 'success');
                }}
                className="flex-1 sm:flex-none px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-luxe-200 hover:bg-slate-100 dark:hover:bg-white/5 border border-slate-200 dark:border-white/10 transition-all"
              >
                Cancelar Edición
              </button>
              <button
                type="submit"
                form="ficha-consulta-form"
                className="flex-1 sm:flex-none px-6 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-bronze-500 to-bronze-600 hover:brightness-110 shadow-md flex items-center justify-center gap-2 transition-all"
              >
                <Save className="w-3.5 h-3.5" /> Guardar Cambios
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PDF Download Choice Modal */}
      {isPdfModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 transition-all duration-300">
          <div className="liquid-glass rounded-3xl p-8 max-w-sm w-full border border-slate-200/50 dark:border-white/5 space-y-6">
            <div className="text-center space-y-2">
              <h3 className="font-outfit text-lg font-bold text-slate-800 dark:text-white">Exportar Documento</h3>
              <p className="text-xs text-slate-500 dark:text-luxe-300">Selecciona el tipo de documento PDF que deseas exportar.</p>
            </div>

            <div className="flex flex-col gap-3">
              <button type="button" onClick={() => triggerPdfDownload('ficha')} className="bg-gradient-to-r from-bronze-500 to-bronze-600 text-white p-4 rounded-2xl text-xs font-bold shadow-md transition-all flex items-center gap-3">
                <FolderHeart className="w-5 h-5 text-white" />
                <div className="flex flex-col text-left">
                  <span className="font-bold leading-tight">Ficha Clínica Completa</span>
                  <span className="text-[10px] opacity-75 font-normal">Historial técnico, biotipo, zonas faciales y protocolo.</span>
                </div>
              </button>

              <button type="button" onClick={() => triggerPdfDownload('receta')} className="bg-gradient-to-r from-amber-500 to-amber-600 text-white p-4 rounded-2xl text-xs font-bold shadow-md transition-all flex items-center gap-3">
                <FileText className="w-5 h-5 text-white" />
                <div className="flex flex-col text-left">
                  <span className="font-bold leading-tight">Receta Médica del Paciente</span>
                  <span className="text-[10px] opacity-75 font-normal">Indicaciones de apoyo en casa, modo de uso.</span>
                </div>
              </button>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-200/10">
              <button type="button" onClick={() => setIsPdfModalOpen(false)} className="px-4 py-2 rounded-xl text-slate-500 dark:text-luxe-300 hover:bg-slate-100 text-xs font-semibold">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Support Button */}
      {isLogged && (
        <div className="fixed bottom-6 right-6 z-50">
          <button
            onClick={() => setIsReportModalOpen(true)}
            className="w-14 h-14 bg-gradient-to-tr from-luxe-500 to-luxe-600 rounded-full flex items-center justify-center text-white shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95 transition-all animate-bounce-slow border-2 border-white/20"
            title="Reportar problema o enviar sugerencia"
          >
            <MessageSquare className="w-6 h-6" />
          </button>
        </div>
      )}

      {/* Support Report Modal */}
      {isReportModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div onPaste={handlePasteImage} className="w-full max-w-lg bg-white dark:bg-luxe-900 rounded-3xl shadow-2xl overflow-hidden border border-slate-100 dark:border-luxe-800 animate-slide-up">
            <div className="p-5 border-b border-slate-100 dark:border-luxe-800 flex items-center justify-between bg-gradient-to-r from-slate-50 to-white dark:from-luxe-900 dark:to-luxe-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-luxe-100 dark:bg-luxe-800 flex items-center justify-center text-luxe-500">
                  <Bug className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-800 dark:text-white font-sora">Soporte Técnico</h3>
                  <p className="text-xs text-slate-500 dark:text-luxe-300">Reporta un error o sugiere mejoras</p>
                </div>
              </div>
              <button onClick={() => setIsReportModalOpen(false)} className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-luxe-800 rounded-xl transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest mb-1.5">
                  ¿En qué sección/pantalla ocurre?
                </label>
                <select 
                  value={reportSection} 
                  onChange={e => setReportSection(e.target.value)} 
                  className="smart-input w-full px-4 py-3 rounded-xl text-sm"
                >
                  <option value="General / Sistema">General / Sistema</option>
                  <option value="Ficha de Diagnóstico (General / Datos del Paciente)">Ficha de Diagnóstico (General / Datos del Paciente)</option>
                  <option value="Procedimiento (Fases de Cabina / Protocolo)">Procedimiento (Fases de Cabina / Protocolo)</option>
                  <option value="Mapa Facial Clínico Interactivo">Mapa Facial Clínico Interactivo</option>
                  <option value="Prescripciones de Apoyo en Casa">Prescripciones de Apoyo en Casa</option>
                  <option value="Catálogo de Productos / Inventario">Catálogo de Productos / Inventario</option>
                  <option value="Búsqueda / Histórico de Expedientes">Búsqueda / Histórico de Expedientes</option>
                  <option value="Estadísticas / Reportes">Estadísticas / Reportes</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest mb-1.5">
                  ¿Qué problema encontraste o qué te gustaría sugerir?
                </label>
                <textarea
                  value={reportMessage}
                  onChange={(e) => setReportMessage(e.target.value)}
                  placeholder="Ej. Al intentar guardar la consulta se queda cargando..."
                  className="w-full bg-slate-50 dark:bg-luxe-950 border border-slate-200 dark:border-luxe-800 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-luxe-500/50 outline-none text-slate-700 dark:text-white transition-all resize-none h-24"
                ></textarea>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="block text-xs font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest">
                    Adjuntar imágenes
                  </label>
                  <label className="text-[10px] text-bronze-600 dark:text-bronze-400 font-semibold cursor-pointer hover:underline">
                    Seleccionar archivos
                    <input type="file" accept="image/*" multiple onChange={handleFileChange} className="hidden" />
                  </label>
                </div>
                
                {/* Keyboard shortcut visual guide */}
                <div className="flex flex-wrap items-center gap-1.5 p-3 rounded-xl bg-slate-50 dark:bg-luxe-950 border border-slate-200/50 dark:border-luxe-800 text-[11px] text-slate-500 dark:text-luxe-300">
                  <span>Tip: Captura pantalla con </span>
                  <div className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-luxe-900 border border-slate-300 dark:border-luxe-800 text-slate-800 dark:text-luxe-100 font-bold shadow-sm flex items-center gap-1 text-[9px]">
                      <svg viewBox="0 0 24 24" className="w-3 h-3 fill-current inline-block"><path d="M0 3.449L9.75 2.1v9.45H0V3.449zM0 12.45h9.75v9.45L0 20.551v-8.1zM11.25 1.9L24 0v11.55H11.25V1.9zm0 10.55H24v11.55l-12.75-1.9v-9.65z"/></svg>
                      Win
                    </kbd>
                    <span>+</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-luxe-900 border border-slate-300 dark:border-luxe-800 text-slate-800 dark:text-luxe-100 font-bold shadow-sm text-[9px] flex items-center gap-0.5">
                      <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 stroke-current fill-none stroke-[2] inline-block"><path d="M12 19V5m0 0l-7 7m7-7l7 7"/></svg>
                      Shift
                    </kbd>
                    <span>+</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-white dark:bg-luxe-900 border border-slate-300 dark:border-luxe-800 text-slate-800 dark:text-luxe-100 font-bold shadow-sm text-[9px]">S</kbd>
                  </div>
                  <span>y pégala aquí (Ctrl + V)</span>
                </div>

                {/* Previews of attached images */}
                {reportImages.length > 0 && (
                  <div className="grid grid-cols-4 gap-2 mt-2">
                    {reportImages.map((file, idx) => {
                      const url = URL.createObjectURL(file);
                      return (
                        <div key={idx} className="relative group aspect-video rounded-lg overflow-hidden border border-slate-200 dark:border-luxe-800 bg-slate-100 dark:bg-luxe-950">
                          <img src={url} className="w-full h-full object-cover" alt="preview" />
                          <button 
                            type="button" 
                            onClick={() => removeReportImage(idx)} 
                            className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-0.5 shadow hover:bg-red-600 transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <p className="text-xs text-slate-400 dark:text-luxe-400 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5" /> Se adjuntará un registro técnico oculto para ayudar al desarrollador.
              </p>
            </div>
            
            <div className="p-5 border-t border-slate-100 dark:border-luxe-800 bg-slate-50 dark:bg-luxe-900 flex justify-end gap-3">
              <button
                onClick={() => setIsReportModalOpen(false)}
                className="px-5 py-2.5 rounded-xl text-slate-600 dark:text-luxe-200 font-semibold text-sm hover:bg-slate-200 dark:hover:bg-luxe-800 transition-colors"
                disabled={isSendingReport}
              >
                Cancelar
              </button>
              <button
                onClick={handleSendReport}
                disabled={!reportMessage.trim() || isSendingReport}
                className="flex items-center gap-2 bg-gradient-to-r from-luxe-500 to-luxe-600 text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSendingReport ? (
                  <>Enviando...</>
                ) : (
                  <>
                    <Send className="w-4 h-4" /> Enviar Reporte
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Digital Móvil interactivo para el Paciente */}
      {showDigitalClientModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-md animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-sm rounded-[40px] shadow-2xl overflow-hidden text-white space-y-4 p-6 relative flex flex-col max-h-[90vh]">
            <button
              onClick={() => setShowDigitalClientModal(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-full bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Simulador de Celular Boutique */}
            <div className="text-center space-y-1 pt-2">
              <div className="w-12 h-1.5 bg-slate-700 rounded-full mx-auto mb-3" />
              <span className="text-[10px] font-bold tracking-widest uppercase text-amber-400 block">Mi Rutina Dermoestética</span>
              <h4 className="font-outfit text-base font-bold">Guía de Apoyo Domiciliario</h4>
              <p className="text-[11px] text-slate-400">Diseñada por tu cosmetóloga profesional</p>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-1 scrollbar-thin">
              {/* Sección Día (AM) */}
              <div className="bg-slate-800/80 p-4 rounded-2xl border border-amber-500/20 space-y-3">
                <h5 className="text-xs font-bold text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
                  ☀️ Rutina de Mañana (AM)
                </h5>
                {prescriptionsList.filter(p => p.timeOfDay === 'Dia' || p.timeOfDay === 'Dia y Noche').length === 0 ? (
                  <p className="text-[11px] text-slate-400 italic">No hay pasos prescritos para la mañana.</p>
                ) : (
                  prescriptionsList
                    .filter(p => p.timeOfDay === 'Dia' || p.timeOfDay === 'Dia y Noche')
                    .sort((a, b) => getLayerOrder(a.stepName || '') - getLayerOrder(b.stepName || ''))
                    .map((p, i) => (
                      <div key={p.id} className="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50 space-y-1 text-xs">
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-amber-300">Paso {i + 1}: {p.stepName}</span>
                          <span className="text-[9px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full font-bold">Capas</span>
                        </div>
                        <span className="font-semibold block text-slate-100">{p.customProductName || p.productDetails?.name}</span>
                        <p className="text-[10px] text-slate-300">{p.dosageInstructions}</p>
                      </div>
                    ))
                )}
              </div>

              {/* Sección Noche (PM) */}
              <div className="bg-slate-800/80 p-4 rounded-2xl border border-indigo-500/20 space-y-3">
                <h5 className="text-xs font-bold text-indigo-300 flex items-center gap-1.5 uppercase tracking-wider">
                  🌙 Rutina de Noche (PM)
                </h5>
                {prescriptionsList.filter(p => p.timeOfDay === 'Noche' || p.timeOfDay === 'Dia y Noche').length === 0 ? (
                  <p className="text-[11px] text-slate-400 italic">No hay pasos prescritos para la noche.</p>
                ) : (
                  prescriptionsList
                    .filter(p => p.timeOfDay === 'Noche' || p.timeOfDay === 'Dia y Noche')
                    .sort((a, b) => getLayerOrder(a.stepName || '') - getLayerOrder(b.stepName || ''))
                    .map((p, i) => (
                      <div key={p.id} className="bg-slate-900/60 p-3 rounded-xl border border-slate-700/50 space-y-1 text-xs">
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-indigo-300">Paso {i + 1}: {p.stepName}</span>
                          <span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full font-bold">Capas</span>
                        </div>
                        <span className="font-semibold block text-slate-100">{p.customProductName || p.productDetails?.name}</span>
                        <p className="text-[10px] text-slate-300">{p.dosageInstructions}</p>
                      </div>
                    ))
                )}
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800 text-center">
              <button
                onClick={() => setShowDigitalClientModal(false)}
                className="w-full bg-amber-500 hover:bg-amber-600 text-slate-950 py-2.5 rounded-xl text-xs font-bold transition-all shadow-md"
              >
                Cerrar Previsualización
              </button>
            </div>
          </div>
        </div>
      )}


      <BackupModal
        isOpen={isBackupModalOpen}
        onClose={() => setIsBackupModalOpen(false)}
        onRestoreComplete={() => {
          bootstrapSystem();
          showToastMsg('Base de datos y catálogo sincronizados.', 'success');
        }}
      />

      <TrashModal
        isOpen={isTrashModalOpen}
        onClose={() => setIsTrashModalOpen(false)}
        deletedPatients={deletedPatients}
        deletedConsultations={deletedConsultationsWithNames}
        onRestorePatient={handleRestorePatient}
        onPermanentlyDeletePatient={handlePermanentlyDeletePatient}
        onRestoreConsultation={handleRestoreConsultation}
        onPermanentlyDeleteConsultation={handlePermanentlyDeleteConsultation}
      />
    </div>
  );
}
