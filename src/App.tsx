import React, { useState, useEffect, useRef } from 'react';
import { db, executeQuery, seedTables, saveConsultationTransaction } from './db';
import { Patient, Anamnesis, Product, Consultation, ConsultationStep, Prescription, ConsultationState } from './types';
import { validateStateTransition } from './stateMachine';
import { encryptData, decryptData, sha256 } from './crypto';
import { ClinicalReportPDF } from './ClinicalReportPDF';
import { pdf } from '@react-pdf/renderer';
import SignaturePad from 'signature_pad';
import Fuse from 'fuse.js';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { 
  Activity, Award, Beaker, CheckCircle, ChevronDown, Clipboard, Clock, CloudDownload, 
  Database, FileText, FileUp, FolderHeart, Info, Layers, Lock, Moon, Plus, Printer, 
  Save, Search, Sparkles, Sun, Trash2, User, UserCheck, Wand2 
} from 'lucide-react';

const FASE_CATEGORY_MAPPING: Record<string, string[]> = {
  "Limpieza": ["Limpiador"],
  "Shampoo": ["Limpiador"],
  "Exfoliación": ["Exfoliante"],
  "Tonificación": ["Regulador pH", "Loción"],
  "Armonizador": ["Armonizador", "Regulador pH", "Loción", "Crema/Gel"],
  "Principio Activo": ["Serum/Vial", "Específico"],
  "Mascarilla": ["Mascarilla"],
  "Crema de Sellado": ["Crema/Gel"],
  "Protección Solar": ["Crema/Gel", "Específico", "Biobotulina"],
  "Apoyo en Casa": ["Alternative", "Rosa Mosq.", "Mulike", "Oro", "Clásica", "Diamante", "Biohelicina", "Biobotulina"]
};

export default function App() {
  // Authentication & Layout States
  const [isLogged, setIsLogged] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [activeTab, setActiveTab] = useState<'generator' | 'inventory' | 'records'>('generator');
  const [syncStatus, setSyncStatus] = useState<'online' | 'local' | 'syncing'>('online');

  // Master Catalogs & Data lists
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<{ name: string; action: string }[]>([]);
  const [records, setRecords] = useState<Consultation[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);

  // Toast State
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error'; visible: boolean }>({ message: '', type: 'success', visible: false });

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
    state: 'Borrador' as ConsultationState
  });

  // Steps / Procedure Designer State
  const [currentSteps, setCurrentSteps] = useState<ConsultationStep[]>([]);
  const [stepInput, setStepInput] = useState({
    stepName: 'Otro',
    customProductName: '',
    customBrand: '',
    customActiveIngredients: '',
    customActions: '',
    applicationDescription: '',
    aparatologySettings: '',
    productId: ''
  });
  const [stepSearchQuery, setStepSearchQuery] = useState('');
  const [stepSuggestions, setStepSuggestions] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  // Cascading dropdown filters
  const [cascadingBrand, setCascadingBrand] = useState('');
  const [cascadingCategory, setCascadingCategory] = useState('');
  const [cascadingProduct, setCascadingProduct] = useState('');

  // Prescription builder state
  const [prescriptionsList, setPrescriptionsList] = useState<Prescription[]>([]);
  const [presInput, setPresInput] = useState({
    productId: '',
    timeOfDay: 'Dia' as 'Dia' | 'Noche' | 'Dia y Noche',
    dosageInstructions: '',
    applicationFrequency: ''
  });

  // Facial interactive canvas state
  const [activeFacialZones, setActiveFacialZones] = useState<Record<string, boolean>>({
    forehead: false, nose: false, leftCheek: false, rightCheek: false, chin: false,
    leftEye: false, rightEye: false, lips: false, neck: false
  });
  const [hoveredZone, setHoveredZone] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Signature Pad state refs
  const specSigCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patSigCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const specSigPadRef = useRef<SignaturePad | null>(null);
  const patSigPadRef = useRef<SignaturePad | null>(null);

  // State PDF choice modal
  const [isPdfModalOpen, setIsPdfModalOpen] = useState(false);

  // Levenshtein & AI recommender Widget states
  const [checkerInput, setCheckerInput] = useState('');
  const [checkerResults, setCheckerResults] = useState<string[]>([]);
  const [aiNotes, setAiNotes] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

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
    retailPrice: '',
    isProfessionalUse: true,
    activeIngredients: '[]',
    physiologicalActions: '[]'
  });
  const [formIngredientInput, setFormIngredientInput] = useState('');
  const [formIngredientAction, setFormIngredientAction] = useState('');
  const [formIngredientsList, setFormIngredientsList] = useState<{ name: string; action: string }[]>([]);
  const [ingredientSuggestions, setIngredientSuggestions] = useState<{ name: string; action: string }[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogBrandFilter, setCatalogBrandFilter] = useState('');
  const [catalogCategoryFilter, setCatalogCategoryFilter] = useState('');

  // Bulk Excel import preview state
  const [uploadPreview, setUploadPreview] = useState<Product[]>([]);
  const [apiBrandSelect, setApiBrandSelect] = useState('');
  const [apiPreview, setApiPreview] = useState<Product[]>([]);

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

    // Check login session
    const isLoggedSession = sessionStorage.getItem('is_logged') === 'true';
    if (isLoggedSession) {
      setIsLogged(true);
      bootstrapSystem();
    }
  }, []);

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

  const bootstrapSystem = async () => {
    setSyncStatus('syncing');
    try {
      await seedTables();
      await loadMasterCatalogs();
      setSyncStatus(navigator.onLine ? 'online' : 'local');
    } catch (e) {
      console.error(e);
      setSyncStatus('local');
    }
  };

  const loadMasterCatalogs = async () => {
    // Load local products
    const pList = await db.products.toArray();
    setProducts(pList);

    // Load ingredients
    const iList = await db.products.toArray(); // map from physiological actions & ingredients
    const resolvedIngredients: { name: string; action: string }[] = [];
    pList.forEach(p => {
      try {
        const actives = JSON.parse(p.activeIngredients) as string[];
        const actions = JSON.parse(p.physiologicalActions) as string[];
        actives.forEach((act, idx) => {
          if (!resolvedIngredients.some(ri => ri.name.toLowerCase() === act.toLowerCase())) {
            resolvedIngredients.push({ name: act, action: actions[idx] || 'Efecto dermoestético' });
          }
        });
      } catch(e) {}
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

  const showToastMsg = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ message: msg, type, visible: true });
    setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }));
    }, 4000);
  };

  // ----------------------------------------------------
  // LOGIN / AUTH
  // ----------------------------------------------------
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);

    try {
      if (navigator.onLine) {
        const res = await executeQuery(
          'SELECT usuario, rol FROM usuarios WHERE usuario = ? AND contrasena = ?',
          [loginUsername.trim(), loginPassword]
        );
        if (res.rows && res.rows.length > 0) {
          sessionStorage.setItem('is_logged', 'true');
          setIsLogged(true);
          showToastMsg('Estación de Diagnóstico Desbloqueada.', 'success');
          bootstrapSystem();
        } else {
          setLoginError('Credenciales incorrectas. Intente de nuevo.');
        }
      } else {
        // Mock offline check
        if (loginUsername === 'clinica_dermatique' && loginPassword === 'Dermatique2026') {
          sessionStorage.setItem('is_logged', 'true');
          setIsLogged(true);
          showToastMsg('Acceso local desbloqueado.', 'success');
          bootstrapSystem();
        } else {
          setLoginError('Modo local: Use las credenciales por defecto.');
        }
      }
    } catch(err) {
      console.error(err);
      setLoginError('Error de red al conectar con Turso.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('is_logged');
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

  // ----------------------------------------------------
  // INTERACTIVE FACIAL CANVAS CANVAS
  // ----------------------------------------------------
  useEffect(() => {
    if (!canvasRef.current || activeTab !== 'generator' || !isLogged) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Redraw whenever active zones or hovered zone changes
    drawFacialSilhouette(ctx, canvas.width, canvas.height);
  }, [activeFacialZones, hoveredZone, activeTab, isLogged]);

  const drawFacialSilhouette = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const scaleX = width / 250;
    const scaleY = height / 250;

    // Draw main silhouette outline
    ctx.beginPath();
    ctx.strokeStyle = theme === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(18, 18, 21, 0.08)';
    ctx.lineWidth = 2;
    ctx.arc(cx, cy - 20 * scaleY, 60 * scaleX, 0, Math.PI * 2);
    ctx.stroke();

    // Neck
    ctx.beginPath();
    ctx.moveTo(cx - 25 * scaleX, cy + 30 * scaleY);
    ctx.lineTo(cx - 35 * scaleX, cy + 90 * scaleY);
    ctx.lineTo(cx + 35 * scaleX, cy + 90 * scaleY);
    ctx.lineTo(cx + 25 * scaleX, cy + 30 * scaleY);
    ctx.closePath();
    ctx.stroke();

    // Draw interactive zones
    const zones: Record<string, { label: string; coords: [number, number, number] }> = {
      forehead: { label: 'Frente', coords: [cx, cy - 60 * scaleY, 20 * scaleX] },
      nose: { label: 'Nariz', coords: [cx, cy, 14 * scaleX] },
      chin: { label: 'Mentón', coords: [cx, cy + 60 * scaleY, 16 * scaleX] },
      rightCheek: { label: 'Mejilla Der', coords: [cx + 35 * scaleX, cy + 10 * scaleY, 22 * scaleX] },
      leftCheek: { label: 'Mejilla Izq', coords: [cx - 35 * scaleX, cy + 10 * scaleY, 22 * scaleX] },
      rightEye: { label: 'Ojo Der', coords: [cx + 25 * scaleX, cy - 25 * scaleY, 12 * scaleX] },
      leftEye: { label: 'Ojo Izq', coords: [cx - 25 * scaleX, cy - 25 * scaleY, 12 * scaleX] },
      lips: { label: 'Labios', coords: [cx, cy + 35 * scaleY, 15 * scaleX] },
      neck: { label: 'Cuello', coords: [cx, cy + 85 * scaleY, 18 * scaleX] }
    };

    Object.entries(zones).forEach(([key, val]) => {
      const isActive = activeFacialZones[key];
      const isHovered = hoveredZone === key;

      ctx.beginPath();
      ctx.arc(val.coords[0], val.coords[1], val.coords[2], 0, Math.PI * 2);

      if (isActive) {
        ctx.fillStyle = 'rgba(212, 175, 55, 0.4)';
        ctx.strokeStyle = '#D4AF37';
      } else if (isHovered) {
        ctx.fillStyle = 'rgba(212, 175, 55, 0.15)';
        ctx.strokeStyle = 'rgba(212, 175, 55, 0.5)';
      } else {
        ctx.fillStyle = theme === 'dark' ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)';
        ctx.strokeStyle = theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
      }

      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();

      // Label
      ctx.fillStyle = theme === 'dark' ? '#FAF9F6' : '#222225';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(val.label, val.coords[0], val.coords[1] + 3);
    });
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const cx = canvasRef.current.width / 2;
    const cy = canvasRef.current.height / 2;
    const scaleX = canvasRef.current.width / 250;
    const scaleY = canvasRef.current.height / 250;

    const zones: Record<string, [number, number, number]> = {
      forehead: [cx, cy - 60 * scaleY, 20 * scaleX],
      nose: [cx, cy, 14 * scaleX],
      chin: [cx, cy + 60 * scaleY, 16 * scaleX],
      rightCheek: [cx + 35 * scaleX, cy + 10 * scaleY, 22 * scaleX],
      leftCheek: [cx - 35 * scaleX, cy + 10 * scaleY, 22 * scaleX],
      rightEye: [cx + 25 * scaleX, cy - 25 * scaleY, 12 * scaleX],
      leftEye: [cx - 25 * scaleX, cy - 25 * scaleY, 12 * scaleX],
      lips: [cx, cy + 35 * scaleY, 15 * scaleX],
      neck: [cx, cy + 85 * scaleY, 18 * scaleX]
    };

    let clickedZone: string | null = null;
    for (const [key, val] of Object.entries(zones)) {
      if (Math.hypot(x - val[0], y - val[1]) < val[2]) {
        clickedZone = key;
        break;
      }
    }

    if (clickedZone) {
      setActiveFacialZones(prev => {
        const nextState = { ...prev, [clickedZone!]: !prev[clickedZone!] };
        
        // Add zone notes to ClinicalNotes SOAP text area
        const activeLabels = Object.entries(nextState)
          .filter(([_, active]) => active)
          .map(([k]) => k);
        
        setPatientForm(prevForm => ({
          ...prevForm,
          clinicalNotes: prevForm.clinicalNotes + `\n- Zona afectada evaluada: ${clickedZone}`
        }));

        return nextState;
      });
      showToastMsg(`Zona ${clickedZone} seleccionada`, 'success');
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const cx = canvasRef.current.width / 2;
    const cy = canvasRef.current.height / 2;
    const scaleX = canvasRef.current.width / 250;
    const scaleY = canvasRef.current.height / 250;

    const zones: Record<string, [number, number, number]> = {
      forehead: [cx, cy - 60 * scaleY, 20 * scaleX],
      nose: [cx, cy, 14 * scaleX],
      chin: [cx, cy + 60 * scaleY, 16 * scaleX],
      rightCheek: [cx + 35 * scaleX, cy + 10 * scaleY, 22 * scaleX],
      leftCheek: [cx - 35 * scaleX, cy + 10 * scaleY, 22 * scaleX],
      rightEye: [cx + 25 * scaleX, cy - 25 * scaleY, 12 * scaleX],
      leftEye: [cx - 25 * scaleX, cy - 25 * scaleY, 12 * scaleX],
      lips: [cx, cy + 35 * scaleY, 15 * scaleX],
      neck: [cx, cy + 85 * scaleY, 18 * scaleX]
    };

    let foundZone: string | null = null;
    for (const [key, val] of Object.entries(zones)) {
      if (Math.hypot(x - val[0], y - val[1]) < val[2]) {
        foundZone = key;
        break;
      }
    }

    if (foundZone !== hoveredZone) {
      setHoveredZone(foundZone);
    }
  };

  // ----------------------------------------------------
  // SIGNATURES CAPTURE
  // ----------------------------------------------------
  useEffect(() => {
    if (activeTab !== 'generator' || !isLogged) return;
    
    setTimeout(() => {
      if (specSigCanvasRef.current && patSigCanvasRef.current) {
        specSigPadRef.current = new SignaturePad(specSigCanvasRef.current, {
          backgroundColor: 'rgb(255, 255, 255)'
        });
        patSigPadRef.current = new SignaturePad(patSigCanvasRef.current, {
          backgroundColor: 'rgb(255, 255, 255)'
        });
      }
    }, 200);
  }, [activeTab, isLogged]);

  const clearSignature = (type: 'especialista' | 'paciente') => {
    if (type === 'especialista' && specSigPadRef.current) {
      specSigPadRef.current.clear();
    } else if (type === 'paciente' && patSigPadRef.current) {
      patSigPadRef.current.clear();
    }
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

    const results = fuse.search(val).map(r => r.item).slice(0, 6);
    setStepSuggestions(results);
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

  const handleAddStep = () => {
    if (!stepInput.customProductName.trim()) {
      showToastMsg('Ingrese el nombre del producto para el paso.', 'error');
      return;
    }

    const newStep: ConsultationStep = {
      id: Math.random().toString(36).substring(2, 9).toUpperCase(),
      consultationId: patientForm.id || 'TEMP',
      stepOrder: currentSteps.length + 1,
      stepName: stepInput.stepName,
      productId: stepInput.productId || undefined,
      customProductName: stepInput.customProductName,
      customBrand: stepInput.customBrand,
      customActiveIngredients: stepInput.customActiveIngredients,
      customActions: stepInput.customActions,
      applicationDescription: stepInput.applicationDescription,
      productDetails: selectedProduct || undefined
    };

    setCurrentSteps(prev => [...prev, newStep]);
    
    // Clear step inputs
    setStepInput({
      stepName: 'Otro',
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
    showToastMsg('Paso agregado al protocolo.', 'success');
  };

  const removeStep = (idx: number) => {
    const nextSteps = [...currentSteps];
    nextSteps.splice(idx, 1);
    // Re-order remaining steps
    const reordered = nextSteps.map((s, i) => ({ ...s, stepOrder: i + 1 }));
    setCurrentSteps(reordered);
  };

  // ----------------------------------------------------
  // RECIPE BUILDER
  // ----------------------------------------------------
  const handleAddPrescription = () => {
    if (!presInput.productId) {
      showToastMsg('Seleccione un producto para prescribir.', 'error');
      return;
    }

    const prod = products.find(p => p.id === presInput.productId);

    const newPres: Prescription = {
      id: Math.random().toString(36).substring(2, 9).toUpperCase(),
      consultationId: patientForm.id || 'TEMP',
      productId: presInput.productId,
      timeOfDay: presInput.timeOfDay,
      dosageInstructions: presInput.dosageInstructions,
      applicationFrequency: presInput.applicationFrequency,
      productDetails: prod
    };

    setPrescriptionsList(prev => [...prev, newPres]);
    setPresInput({
      productId: '',
      timeOfDay: 'Dia',
      dosageInstructions: '',
      applicationFrequency: ''
    });
    showToastMsg('Recomendación de apoyo agregada.', 'success');
  };

  const removePrescription = (idx: number) => {
    const list = [...prescriptionsList];
    list.splice(idx, 1);
    setPrescriptionsList(list);
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
      // 1. Compute Cryptography for PHI locally (Web Crypto API)
      const firstNameEnc = await encryptData(patientForm.firstName);
      const lastNameEnc = await encryptData(patientForm.lastName);
      const phoneEnc = await encryptData(patientForm.phone);
      const emailH = await sha256(patientForm.email || `${patientForm.firstName}.${patientForm.lastName}@clinical.local`);

      const consultationId = patientForm.id || `C-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
      const patientId = `P-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

      // Register patient on remote if online
      if (navigator.onLine) {
        await executeQuery(
          `INSERT OR REPLACE INTO patients (id, first_name_encrypted, last_name_encrypted, date_of_birth, email_hashed, phone_encrypted)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [patientId, firstNameEnc, lastNameEnc, patientForm.dateOfBirth || '2000-01-01', emailH, phoneEnc]
        );

        await executeQuery(
          `INSERT OR REPLACE INTO anamnesis (id, patient_id, medical_diagnosis, surgical_history, allergies_cosmetics, current_medications, lifestyle_metrics)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [`A-${patientId}`, patientId, patientForm.medicalDiagnosis || null, patientForm.surgicalHistory || null, patientForm.allergiesCosmetics, patientForm.currentMedications, patientForm.lifestyleMetrics]
        );
      }

      // Local Dexie Save for patient
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
      await db.patients.put(localPatient);

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
        state: patientForm.state
      };

      const finalSteps = currentSteps.map(s => ({ ...s, consultationId }));
      const finalPrescriptions = prescriptionsList.map(p => ({ ...p, consultationId }));

      // Trigger ACID atomicity remote & local
      await saveConsultationTransaction(finalConsultation, finalSteps, finalPrescriptions);

      showToastMsg('Expediente clínico guardado atómicamente.', 'success');
      loadMasterCatalogs();
      resetPatientForm();
    } catch(err) {
      console.error(err);
      showToastMsg('Fallo en la transacción de guardado clínico.', 'error');
    }
  };

  const resetPatientForm = () => {
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
      state: 'Borrador'
    });
    setCurrentSteps([]);
    setPrescriptionsList([]);
    setActiveFacialZones({
      forehead: false, nose: false, leftCheek: false, rightCheek: false, chin: false,
      leftEye: false, rightEye: false, lips: false, neck: false
    });
    clearSignature('especialista');
    clearSignature('paciente');
  };

  // ----------------------------------------------------
  // PDF VECTOR COMPILER (@react-pdf/renderer)
  // ----------------------------------------------------
  const triggerPdfDownload = async (type: 'ficha' | 'receta') => {
    setIsPdfModalOpen(false);
    showToastMsg('Compilando expediente en PDF...', 'success');

    try {
      const mockPatient: Patient = {
        id: patientForm.id || 'P-0001',
        firstNameEncrypted: patientForm.firstName || 'Paciente',
        lastNameEncrypted: patientForm.lastName || 'Prueba',
        dateOfBirth: patientForm.dateOfBirth || '2000-01-01',
        emailHashed: '',
        phoneEncrypted: patientForm.phone || '0000000000',
        createdAt: '',
        updatedAt: ''
      };

      const mockConsultation: Consultation = {
        id: patientForm.id || 'C-2026-0001',
        patientId: mockPatient.id,
        providerId: 'clinica_dermatique',
        visitDate: new Date().toISOString(),
        skinBiotype: patientForm.skinBiotype || 'Eudérmica / Normal',
        fitzpatrickScale: patientForm.fitzpatrickScale,
        skinConditions: patientForm.skinConditions,
        medicalDiagnosis: patientForm.medicalDiagnosis || 'Ninguno',
        clinicalNotes: patientForm.clinicalNotes || 'Sin notas adicionales.',
        state: patientForm.state,
        steps: currentSteps,
        prescriptions: prescriptionsList
      };

      const doc = <ClinicalReportPDF patient={mockPatient} consultation={mockConsultation} type={type} />;
      const blob = await pdf(doc).toBlob();
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `${type === 'ficha' ? 'Ficha_Clinica' : 'Receta_Apoyo'}_${mockPatient.firstNameEncrypted}_${mockConsultation.id}.pdf`;
      link.click();
      
      showToastMsg('PDF descargado con éxito.', 'success');
    } catch(e) {
      console.error(e);
      showToastMsg('Fallo al generar archivo PDF.', 'error');
    }
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

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productForm.name || !productForm.sku || !productForm.brandLine) {
      showToastMsg('Nombre, SKU y marca son obligatorios.', 'error');
      return;
    }

    const actives = formIngredientsList.map(i => i.name);
    const actions = formIngredientsList.map(i => i.action);

    const newProd: Product = {
      id: productForm.id || `PROD-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
      sku: productForm.sku,
      name: productForm.name,
      brandLine: productForm.brandLine,
      retailPrice: parseFloat(productForm.retailPrice) || 0,
      isProfessionalUse: productForm.isProfessionalUse,
      activeIngredients: JSON.stringify(actives),
      physiologicalActions: JSON.stringify(actions)
    };

    if (navigator.onLine) {
      await executeQuery(
        `INSERT OR REPLACE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newProd.id, newProd.sku, newProd.name, newProd.brandLine, newProd.activeIngredients, newProd.physiologicalActions, newProd.retailPrice, newProd.isProfessionalUse ? 1 : 0]
      );
    }

    await db.products.put(newProd);
    showToastMsg('Producto guardado en catálogo.', 'success');
    setIsProductFormOpen(false);
    loadMasterCatalogs();
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

  // Levenshtein Corrector
  const runLevenshteinCheck = () => {
    if (!checkerInput.trim()) return;
    const query = checkerInput.trim().toLowerCase();
    
    // Levenshtein distance implementation
    const getDistance = (s: string, t: string) => {
      if (!s.length) return t.length;
      if (!t.length) return s.length;
      const arr = [];
      for (let i = 0; i <= t.length; i++) {
        arr[i] = [i];
      }
      for (let j = 0; j <= s.length; j++) {
        arr[0][j] = j;
      }
      for (let i = 1; i <= t.length; i++) {
        for (let j = 1; j <= s.length; j++) {
          arr[i][j] = t[i - 1] === s[j - 1]
            ? arr[i - 1][j - 1]
            : Math.min(arr[i - 1][j - 1] + 1, Math.min(arr[i][j - 1] + 1, arr[i - 1][j] + 1));
        }
      }
      return arr[t.length][s.length];
    };

    const matches = ingredients
      .map(i => ({ name: i.name, dist: getDistance(query, i.name.toLowerCase()) }))
      .filter(m => m.dist < 5)
      .sort((a, b) => a.dist - b.dist)
      .map(m => m.name);

    setCheckerResults(matches.length > 0 ? matches : ['No se encontraron sugerencias cercanas.']);
  };

  // ----------------------------------------------------
  // EXCEL BULK INGEST (PapaParse / SheetJS)
  // ----------------------------------------------------
  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = new Uint8Array(evt.target?.result as ArrayBuffer);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet) as any[];

      const mapped: Product[] = json.map((row, idx) => ({
        id: `EXCEL-${idx}-${Math.floor(Math.random() * 1000)}`,
        sku: row.SKU || `SKU-${idx}`,
        name: row.Nombre || row.Producto || 'Insumo importado',
        brandLine: row.Marca || 'Genérico',
        retailPrice: parseFloat(row.Precio) || 0,
        isProfessionalUse: row.UsoProfesional === 'Sí' || row.UsoProfesional === 1,
        activeIngredients: JSON.stringify(row.Activos ? String(row.Activos).split(',') : []),
        physiologicalActions: JSON.stringify(row.Acciones ? String(row.Acciones).split(',') : [])
      }));

      setUploadPreview(mapped);
      showToastMsg(`Previsualizando ${mapped.length} productos del archivo.`, 'success');
    };
    reader.readAsArrayBuffer(file);
  };

  const confirmBulkImport = async () => {
    if (uploadPreview.length === 0) return;
    try {
      for (const p of uploadPreview) {
        if (navigator.onLine) {
          await executeQuery(
            `INSERT OR REPLACE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.id, p.sku, p.name, p.brandLine, p.activeIngredients, p.physiologicalActions, p.retailPrice, p.isProfessionalUse ? 1 : 0]
          );
        }
        await db.products.put(p);
      }
      showToastMsg('Catálogo importado y sincronizado con éxito.', 'success');
      setUploadPreview([]);
      loadMasterCatalogs();
    } catch(err) {
      console.error(err);
      showToastMsg('Error al importar catálogo masivamente.', 'error');
    }
  };

  // ----------------------------------------------------
  // RENDER STATION
  // ----------------------------------------------------
  if (!isLogged) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/90 dark:bg-black/90 p-4">
        <div className="liquid-glass w-full max-w-md p-8 rounded-[32px] border border-slate-200/50 dark:border-white/5 shadow-2xl flex flex-col justify-center gap-6">
          <div className="text-center flex flex-col items-center gap-2">
            <img src="https://raw.githubusercontent.com/carlosgbd94-design/Logos/refs/heads/main/logo_xarixuri_cosmetolog_a-removebg-preview.png" alt="Xarixuri Cosmetología" className="h-16 w-auto object-contain dark:brightness-110 mb-2" />
            <h2 className="font-outfit text-xl font-bold text-slate-800 dark:text-white">Estación Médica Estética</h2>
            <p className="text-xs text-slate-500 dark:text-luxe-300">Identifíquese para acceder a la plataforma sanitaria</p>
          </div>

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Usuario</label>
              <input type="text" value={loginUsername} onChange={e => setLoginUsername(e.target.value)} placeholder="Nombre de usuario..." required className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Contraseña</label>
              <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} placeholder="••••••••" required className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
            </div>

            {loginError && (
              <div className="text-xs text-red-500 dark:text-red-400 font-semibold text-center mt-2">{loginError}</div>
            )}

            <button type="submit" disabled={loginLoading} className="w-full bg-gradient-to-r from-amber-500 to-bronze-600 hover:brightness-110 text-white py-3.5 rounded-xl text-xs font-bold shadow-lg transition-all flex items-center justify-center gap-2">
              <span>{loginLoading ? 'Verificando...' : 'Ingresar a Estación'}</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAF9F6] dark:bg-[#0A0A0D] text-slate-700 dark:text-luxe-100 pb-16 antialiased">
      {/* Sync / Toast Notifications */}
      {toast.visible && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-2xl max-w-md border border-slate-200/50 dark:border-white/10 text-slate-800 dark:text-white bg-white/90 dark:bg-luxe-800/90 backdrop-blur-md`}>
          {toast.type === 'success' ? <CheckCircle className="w-5 h-5 text-emerald-400" /> : <Info className="w-5 h-5 text-red-400" />}
          <p className="text-sm font-medium tracking-wide">{toast.message}</p>
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

          <div className="hidden md:flex items-center gap-3">
            <button onClick={toggleTheme} className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-700 dark:text-luxe-300 flex items-center justify-center">{theme === 'light' ? <Moon className="w-4.5 h-4.5" /> : <Sun className="w-4.5 h-4.5" />}</button>
            <button onClick={handleLogout} className="w-10 h-10 rounded-xl bg-red-100/50 dark:bg-red-500/10 text-red-600 flex items-center justify-center"><Lock className="w-4.5 h-4.5" /></button>
          </div>
        </div>
      </nav>

      {/* Main Workspace */}
      <main className="max-w-7xl mx-auto px-6 mt-8">
        
        {/* TAB 1: GENERADOR CLINICO */}
        {activeTab === 'generator' && (
          <div className="space-y-8">
            <div className="liquid-glass rounded-[32px] p-8 md:p-10 relative overflow-hidden">
              <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-bronze-500/10 blur-[100px] pointer-events-none" />

              <div className="flex justify-between items-start mb-8 pb-6 border-b border-slate-200/50 dark:border-white/5">
                <div>
                  <h1 className="font-outfit text-2xl font-bold text-slate-800 dark:text-white">Ficha de Diagnóstico Estético</h1>
                  <p className="text-slate-500 dark:text-luxe-300 text-xs mt-1">Valoración cutánea y recomendación cosmética profesional</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {/* Stepper State Machine Controller */}
                  <div className="flex gap-1.5 bg-slate-100 dark:bg-white/5 p-1 rounded-xl">
                    {(['Borrador', 'Admision', 'Consentimiento', 'Tratamiento', 'Evaluacion'] as ConsultationState[]).map(st => (
                      <button key={st} type="button" onClick={() => updateState(st)} className={`px-2 py-1 rounded-lg text-[9px] font-bold tracking-wider uppercase transition-all ${patientForm.state === st ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-400 dark:text-luxe-400 hover:text-slate-700'}`}>
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <form onSubmit={handleSaveConsultation} className="space-y-6">
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

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Biotipo Cutáneo</label>
                    <select value={patientForm.skinBiotype} onChange={e => setPatientForm(prev => ({ ...prev, skinBiotype: e.target.value }))} required className="smart-input w-full px-4 py-3 rounded-xl text-sm appearance-none bg-no-repeat bg-[right_1rem_center]">
                      <option value="" disabled hidden>Seleccionar biotipo...</option>
                      <option value="Eudérmica / Normal">Eudérmica / Normal</option>
                      <option value="Seca / Alípica">Seca / Alípica</option>
                      <option value="Grasa deshidratada">Grasa deshidratada</option>
                      <option value="Grasa seborreica">Grasa seborreica</option>
                      <option value="Mixta">Mixta</option>
                      <option value="Sensible / Rosácea">Sensible / Rosácea</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Fototipo Fitzpatrick</label>
                    <input type="number" min="1" max="6" value={patientForm.fitzpatrickScale} onChange={e => setPatientForm(prev => ({ ...prev, fitzpatrickScale: parseInt(e.target.value) || 1 }))} className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Diagnóstico Médico General</label>
                    <input type="text" value={patientForm.medicalDiagnosis} onChange={e => setPatientForm(prev => ({ ...prev, medicalDiagnosis: e.target.value }))} placeholder="P. ej., Dermatitis atópica..." className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                </div>

                {/* Facial Canvas Map */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Notas Clínicas SOAP / Zonas Afectadas</label>
                    <textarea value={patientForm.clinicalNotes} onChange={e => setPatientForm(prev => ({ ...prev, clinicalNotes: e.target.value }))} rows={8} placeholder="Diagnóstico de cabina y observaciones clínicas..." required className="smart-input w-full p-4 rounded-xl text-sm resize-none" />
                  </div>
                  
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Mapa Facial Clínico Interactivo</label>
                    <div className="liquid-glass-light rounded-[24px] p-4 flex items-center justify-center border border-slate-200/50 dark:border-white/5 min-h-[220px]">
                      <canvas ref={canvasRef} width={250} height={250} onClick={handleCanvasClick} onMouseMove={handleCanvasMouseMove} className="cursor-pointer max-w-full max-h-full" />
                    </div>
                  </div>
                </div>

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
                              <div key={p.id} onClick={() => selectSearchProduct(p)} className="p-2.5 hover:bg-slate-100 dark:hover:bg-white/5 border-b border-slate-100 dark:border-white/5 last:border-0 cursor-pointer text-xs">
                                <span className="font-bold text-slate-800 dark:text-white">{p.name} ({p.brandLine})</span>
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
                          <option value="Exfoliación">Exfoliación / Peeling</option>
                          <option value="Tonificación">Tonificación / Loción</option>
                          <option value="Armonizador">Armonizador</option>
                          <option value="Principio Activo">Sérum / Activo</option>
                          <option value="Mascarilla">Mascarilla</option>
                          <option value="Crema de Sellado">Crema de Sellado</option>
                          <option value="Protección Solar">Protección Solar</option>
                          <option value="Apoyo en Casa">Apoyo en Casa</option>
                          <option value="Otro">Otro</option>
                        </select>
                      </div>
                    </div>

                    <div className="lg:col-span-7 space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <input type="text" value={stepInput.customProductName} onChange={e => setStepInput(prev => ({ ...prev, customProductName: e.target.value }))} placeholder="Nombre del Producto..." className="smart-input w-full" />
                        <input type="text" value={stepInput.customBrand} onChange={e => setStepInput(prev => ({ ...prev, customBrand: e.target.value }))} placeholder="Marca/Línea..." className="smart-input w-full" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <input type="text" value={stepInput.customActiveIngredients} onChange={e => setStepInput(prev => ({ ...prev, customActiveIngredients: e.target.value }))} placeholder="Activos Clave..." className="smart-input w-full" />
                        <input type="text" value={stepInput.customActions} onChange={e => setStepInput(prev => ({ ...prev, customActions: e.target.value }))} placeholder="Acción Dermoestética..." className="smart-input w-full" />
                      </div>
                      <textarea value={stepInput.applicationDescription} onChange={e => setStepInput(prev => ({ ...prev, applicationDescription: e.target.value }))} rows={2} placeholder="Descripción de Aplicación (maniobras, pose, neutralizador...)" className="smart-input w-full resize-none" />

                      <button type="button" onClick={handleAddStep} className="w-full bg-gradient-to-r from-bronze-500 to-bronze-600 hover:brightness-110 text-white py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5">
                        <Plus className="w-4 h-4" /> Agregar Paso al Protocolo
                      </button>
                    </div>
                  </div>

                  {/* List of Added Steps */}
                  <div className="border border-slate-200/50 dark:border-white/5 rounded-2xl overflow-hidden bg-white/40 dark:bg-luxe-950/20">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-100/60 dark:bg-white/5 border-b border-slate-200/50 dark:border-white/5 text-[10px] font-bold uppercase tracking-wider">
                          <th className="py-3 px-4">Orden</th>
                          <th className="py-3 px-4">Fase</th>
                          <th className="py-3 px-4">Producto</th>
                          <th className="py-3 px-4">Marca</th>
                          <th className="py-3 px-4">Acción</th>
                          <th className="py-3 px-4 text-right">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                        {currentSteps.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-6 text-center text-slate-400 italic">No se han añadido pasos.</td>
                          </tr>
                        ) : (
                          currentSteps.map((step, idx) => (
                            <tr key={step.id}>
                              <td className="py-3 px-4">{step.stepOrder}</td>
                              <td className="py-3 px-4 font-bold">{step.stepName}</td>
                              <td className="py-3 px-4">{step.customProductName}</td>
                              <td className="py-3 px-4">{step.customBrand}</td>
                              <td className="py-3 px-4">{step.customActions}</td>
                              <td className="py-3 px-4 text-right">
                                <button type="button" onClick={() => removeStep(idx)} className="text-red-500 hover:underline"><Trash2 className="w-4 h-4" /></button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Recetario de Apoyo en Casa */}
                <div className="liquid-glass-light rounded-2xl p-6 border border-slate-200/50 dark:border-white/5 space-y-6">
                  <h3 className="font-outfit text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                    <Wand2 className="w-4 h-4 text-amber-500" />
                    Prescripciones de Apoyo en Casa
                  </h3>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest">Producto dermoestético</label>
                      <select value={presInput.productId} onChange={e => setPresInput(prev => ({ ...prev, productId: e.target.value }))} className="smart-input w-full">
                        <option value="" disabled hidden>Seleccionar producto...</option>
                        {products.map(p => (
                          <option key={p.id} value={p.id}>{p.name} ({p.brandLine})</option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest">Horario de Uso</label>
                      <select value={presInput.timeOfDay} onChange={e => setPresInput(prev => ({ ...prev, timeOfDay: e.target.value as any }))} className="smart-input w-full">
                        <option value="Dia">Día</option>
                        <option value="Noche">Noche</option>
                        <option value="Dia y Noche">Día y Noche</option>
                      </select>
                    </div>

                    <input type="text" value={presInput.dosageInstructions} onChange={e => setPresInput(prev => ({ ...prev, dosageInstructions: e.target.value }))} placeholder="Instrucciones clínicas..." className="smart-input w-full" />
                    <input type="text" value={presInput.applicationFrequency} onChange={e => setPresInput(prev => ({ ...prev, applicationFrequency: e.target.value }))} placeholder="Frecuencia..." className="smart-input w-full" />
                  </div>

                  <button type="button" onClick={handleAddPrescription} className="bg-gradient-to-r from-amber-500 to-amber-600 text-white px-6 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5">
                    <Plus className="w-4 h-4" /> Agregar Receta
                  </button>

                  {/* List of Prescriptions */}
                  <div className="border border-slate-200/50 dark:border-white/5 rounded-2xl overflow-hidden bg-white/40 dark:bg-luxe-950/20">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-100/60 dark:bg-white/5 border-b border-slate-200/50 dark:border-white/5 text-[10px] font-bold uppercase tracking-wider">
                          <th className="py-3 px-4">Producto</th>
                          <th className="py-3 px-4">Aplicación</th>
                          <th className="py-3 px-4">Instrucciones</th>
                          <th className="py-3 px-4 text-right">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                        {prescriptionsList.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-slate-400 italic">No hay recetas configuradas.</td>
                          </tr>
                        ) : (
                          prescriptionsList.map((pres, idx) => (
                            <tr key={pres.id}>
                              <td className="py-3 px-4 font-bold">{pres.productDetails?.name}</td>
                              <td className="py-3 px-4">{pres.timeOfDay} ({pres.applicationFrequency})</td>
                              <td className="py-3 px-4">{pres.dosageInstructions}</td>
                              <td className="py-3 px-4 text-right">
                                <button type="button" onClick={() => removePrescription(idx)} className="text-red-500 hover:underline"><Trash2 className="w-4 h-4" /></button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Captured Signatures */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 border-t border-slate-200/50 dark:border-white/5 pt-8">
                  <div className="flex flex-col">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest">Firma del Especialista</span>
                      <button type="button" onClick={() => clearSignature('especialista')} className="text-[9px] font-semibold text-red-500 hover:underline">Limpiar</button>
                    </div>
                    <div className="relative bg-white border border-slate-200/50 dark:border-white/10 rounded-2xl overflow-hidden h-36 flex items-center justify-center shadow-inner">
                      <canvas ref={specSigCanvasRef} className="w-full h-full cursor-crosshair" />
                    </div>
                  </div>

                  <div className="flex flex-col">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest">Firma del Paciente</span>
                      <button type="button" onClick={() => clearSignature('paciente')} className="text-[9px] font-semibold text-red-500 hover:underline">Limpiar</button>
                    </div>
                    <div className="relative bg-white border border-slate-200/50 dark:border-white/10 rounded-2xl overflow-hidden h-36 flex items-center justify-center shadow-inner">
                      <canvas ref={patSigCanvasRef} className="w-full h-full cursor-crosshair" />
                    </div>
                  </div>
                </div>

                {/* Final Form Operations */}
                <div className="flex justify-end gap-4 pt-6 border-t border-slate-200/50 dark:border-white/5">
                  <button type="button" onClick={resetPatientForm} className="px-5 py-3 rounded-xl text-slate-500 dark:text-luxe-300 hover:bg-slate-100 dark:hover:bg-white/5 text-xs font-semibold tracking-wide">
                    Limpiar Ficha
                  </button>
                  <button type="button" onClick={() => setIsPdfModalOpen(true)} className="bg-gradient-to-r from-amber-500 to-bronze-600 hover:brightness-110 text-white px-6 py-3 rounded-xl text-xs font-bold shadow-lg transition-all flex items-center gap-2">
                    <FileText className="w-4 h-4" /> Exportar PDF Directo
                  </button>
                  <button type="submit" className="bg-gradient-to-r from-bronze-500 to-bronze-600 hover:brightness-110 text-white px-8 py-3 rounded-xl text-xs font-bold shadow-lg transition-all flex items-center gap-2">
                    <Save className="w-4 h-4" /> Guardar Ficha Paciente
                  </button>
                </div>
              </form>
            </div>

            {/* Levenshtein Corrections Engine Widget */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="liquid-glass rounded-3xl p-8 md:col-span-2 space-y-4">
                <div className="flex items-center gap-2">
                  <Activity className="w-5 h-5 text-bronze-500" />
                  <h2 className="font-outfit text-lg font-bold text-slate-800 dark:text-white">Corrector Inteligente de Activos</h2>
                </div>
                <p className="text-slate-500 dark:text-luxe-300 text-xs">
                  Verifique la ortografía de los activos de forma interactiva con el Algoritmo de Levenshtein.
                </p>

                <div className="relative">
                  <input type="text" value={checkerInput} onChange={e => setCheckerInput(e.target.value)} placeholder="Ej: Santalum albu..." className="smart-input w-full pr-24 py-3.5 rounded-xl text-xs" />
                  <button type="button" onClick={runLevenshteinCheck} className="absolute right-2 top-2 bg-gradient-to-r from-bronze-500 to-bronze-600 text-white px-4 py-2 rounded-lg text-[10px] font-bold shadow transition-all hover:brightness-105">
                    Buscar Activo
                  </button>
                </div>
              </div>

              <div className="liquid-glass rounded-3xl p-6 flex flex-col justify-between border border-slate-200/50 dark:border-white/5">
                <div>
                  <h3 className="text-[9px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest mb-3">Resultados sugeridos</h3>
                  <div className="text-xs text-slate-650 dark:text-luxe-200 space-y-2">
                    {checkerResults.length === 0 ? (
                      <p className="text-slate-400 italic">Los resultados aparecerán aquí...</p>
                    ) : (
                      checkerResults.map((m, i) => <p key={i} className="font-semibold">{m}</p>)
                    )}
                  </div>
                </div>
              </div>
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
                setProductForm({ id: '', sku: '', name: '', brandLine: '', retailPrice: '', isProfessionalUse: true, activeIngredients: '[]', physiologicalActions: '[]' });
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
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    <input type="text" value={productForm.name} onChange={e => setProductForm(prev => ({ ...prev, name: e.target.value }))} placeholder="Nombre comercial..." required className="smart-input w-full" />
                    <input type="text" value={productForm.sku} onChange={e => setProductForm(prev => ({ ...prev, sku: e.target.value }))} placeholder="SKU/Código..." required className="smart-input w-full" />
                    <input type="text" value={productForm.brandLine} onChange={e => setProductForm(prev => ({ ...prev, brandLine: e.target.value }))} placeholder="Marca/Línea..." required className="smart-input w-full" />
                    <input type="number" step="0.01" value={productForm.retailPrice} onChange={e => setProductForm(prev => ({ ...prev, retailPrice: e.target.value }))} placeholder="Precio al público (MXN)..." required className="smart-input w-full" />
                  </div>

                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked={productForm.isProfessionalUse} onChange={e => setProductForm(prev => ({ ...prev, isProfessionalUse: e.target.checked }))} className="rounded border-slate-350 w-4 h-4" />
                    <label className="text-xs font-semibold">Producto de uso profesional / exclusivo en cabina</label>
                  </div>

                  {/* Formulation Lab Integration */}
                  <div className="border border-slate-200/50 dark:border-white/5 bg-slate-500/5 p-6 rounded-2xl space-y-4">
                    <h4 className="font-outfit text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                      <Beaker className="w-4 h-4 text-bronze-500" /> Laboratorio de Activos y Formulación
                    </h4>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                      <div className="md:col-span-4 flex flex-col gap-1.5 relative">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Ingrediente Activo</label>
                        <input type="text" value={formIngredientInput} onChange={e => handleProductIngredientSearch(e.target.value)} placeholder="Ej: Centella..." className="smart-input w-full" />
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
                      <div className="md:col-span-6 flex flex-col gap-1.5">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Acción / Efecto Clínico de este Activo</label>
                        <input type="text" value={formIngredientAction} onChange={e => setFormIngredientAction(e.target.value)} placeholder="Ej: Estimula colágeno..." className="smart-input w-full" />
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
                            <span>{ing.name} ({ing.action})</span>
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
                      <th className="py-3.5 px-4 font-bold">Marca</th>
                      <th className="py-3.5 px-4 font-bold">Precio</th>
                      <th className="py-3.5 px-4 font-bold">Activos</th>
                      <th className="py-3.5 px-4 font-bold">Uso</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                    {products
                      .filter(p => p.name.toLowerCase().includes(catalogSearch.toLowerCase()))
                      .map(p => {
                        let parsedActives = '';
                        try {
                          parsedActives = JSON.parse(p.activeIngredients).join(', ');
                        } catch(e) {
                          parsedActives = p.activeIngredients;
                        }
                        return (
                          <tr key={p.id}>
                            <td className="py-3.5 px-4">{p.sku}</td>
                            <td className="py-3.5 px-4 font-bold">{p.name}</td>
                            <td className="py-3.5 px-4">{p.brandLine}</td>
                            <td className="py-3.5 px-4">${p.retailPrice.toFixed(2)} MXN</td>
                            <td className="py-3.5 px-4 truncate max-w-[200px]">{parsedActives}</td>
                            <td className="py-3.5 px-4">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${p.isProfessionalUse ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                                {p.isProfessionalUse ? 'Cabina' : 'Domicilio'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bulk File upload */}
            <div className="liquid-glass rounded-3xl p-8">
              <h2 className="font-outfit text-xl font-bold text-slate-800 dark:text-white mb-2">Importación de Catálogo</h2>
              <p className="text-slate-500 dark:text-luxe-300 text-xs mb-6">Arrastra y suelta tu archivo Excel del catálogo corregido para actualizar masivamente el inventario.</p>

              <div className="border-2 border-dashed border-slate-300 dark:border-white/10 hover:border-bronze-500/50 rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer bg-slate-50/50 dark:bg-white/[0.01] hover:bg-bronze-500/[0.02] relative">
                <input type="file" accept=".xlsx, .xls" onChange={handleExcelUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                <FileUp className="w-10 h-10 text-bronze-500 mb-4" />
                <p className="text-xs font-semibold">Selecciona o arrastra tu archivo Excel (.xlsx, .xls)</p>
              </div>

              {uploadPreview.length > 0 && (
                <div className="mt-6 space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-bold text-slate-400">Total a importar: {uploadPreview.length} productos</span>
                    <button onClick={confirmBulkImport} className="bg-gradient-to-r from-bronze-500 to-bronze-600 text-white px-6 py-2 rounded-xl text-xs font-bold">
                      Confirmar e Importar Catálogo
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: RECORDS HISTORY */}
        {activeTab === 'records' && (
          <div className="space-y-8">
            <div>
              <h2 className="font-outfit text-2xl font-bold text-slate-800 dark:text-white">Expedientes Clínicos Históricos</h2>
              <p className="text-slate-500 dark:text-luxe-300 text-xs mt-1">Archivo de tratamientos integrales y hojas de diagnóstico cosmetológico.</p>
            </div>

            <div className="liquid-glass rounded-[32px] p-6 md:p-8 border border-slate-200/50 dark:border-white/5 shadow-xl relative overflow-hidden">
              <div className="max-h-[600px] overflow-y-auto overflow-x-auto relative">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-luxe-900 border-b border-slate-200/50 dark:border-white/5 shadow-sm">
                    <tr>
                      <th className="py-3.5 px-4 font-bold">Folio</th>
                      <th className="py-3.5 px-4 font-bold">Fecha</th>
                      <th className="py-3.5 px-4 font-bold">Biotipo</th>
                      <th className="py-3.5 px-4 font-bold">Estado</th>
                      <th className="py-3.5 px-4 font-bold">Notas SOAP</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                    {records.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 px-4 text-center text-slate-400">No hay expedientes clínicos guardados.</td>
                      </tr>
                    ) : (
                      records.map(r => (
                        <tr key={r.id}>
                          <td className="py-3.5 px-4 font-bold">{r.id}</td>
                          <td className="py-3.5 px-4">{new Date(r.visitDate).toLocaleDateString()}</td>
                          <td className="py-3.5 px-4 text-amber-500 font-bold">{r.skinBiotype}</td>
                          <td className="py-3.5 px-4">
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-500">{r.state}</span>
                          </td>
                          <td className="py-3.5 px-4 truncate max-w-[250px]">{r.clinicalNotes}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

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
    </div>
  );
}
