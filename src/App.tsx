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
  Save, Search, Sparkles, Sun, Trash2, User, UserCheck, Wand2, Bug, MessageSquare, X, Send, Edit, Pencil
} from 'lucide-react';
import { sendManualReport } from './errorHandler';

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
    recommendations: ''
  });

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

  // Facial interactive canvas state
  const [activeFacialZones, setActiveFacialZones] = useState<Record<string, boolean>>({
    forehead: false, nose: false, leftCheek: false, rightCheek: false, chin: false,
    leftEye: false, rightEye: false, lips: false, neck: false
  });
  const [hoveredZone, setHoveredZone] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Signature Pad state refs
  const specSigCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const patSigCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const specSigPadRef = useRef<SignaturePad | null>(null);
  const patSigPadRef = useRef<SignaturePad | null>(null);

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
    isProfessionalUse: 1,
    activeIngredients: '[]',
    physiologicalActions: '[]',
    skinBiotypes: '[]'
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
  // PATIENT FOLDERS & SEARCH/FILTER STATE (TAB 3)
  // ----------------------------------------------------
  const [folderSearchQuery, setFolderSearchQuery] = useState('');
  const [folderBiotypeFilter, setFolderBiotypeFilter] = useState('');
  const [expandedPatientFolders, setExpandedPatientFolders] = useState<Record<string, boolean>>({});

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
  async function bootstrapSystem() {
    setSyncStatus('syncing');
    try {
      await seedTables();

      // Sync remote products to local Dexie on start
      if (navigator.onLine) {
        try {
          // 1. Sync products
          const resProds = await executeQuery('SELECT id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use, skin_biotypes FROM products');
          if (resProds && resProds.rows) {
            await db.products.clear();
            for (const r of resProds.rows) {
              await db.products.put({
                id: r.id,
                sku: r.sku,
                name: r.name,
                brandLine: r.brand_line,
                activeIngredients: r.active_ingredients,
                physiologicalActions: r.physiological_actions,
                retailPrice: Number(r.retail_price),
                isProfessionalUse: Number(r.is_professional_use),
                skinBiotypes: r.skin_biotypes || '[]'
              });
            }
          }

          // 2. Sync patients
          const resPatients = await executeQuery('SELECT id, first_name_encrypted, last_name_encrypted, date_of_birth, email_hashed, phone_encrypted, created_at, updated_at FROM patients');
          if (resPatients && resPatients.rows) {
            for (const r of resPatients.rows) {
              const decryptedFirstName = await decryptData(r.first_name_encrypted);
              const decryptedLastName = await decryptData(r.last_name_encrypted);
              const decryptedPhone = await decryptData(r.phone_encrypted);
              await db.patients.put({
                id: r.id,
                firstNameEncrypted: decryptedFirstName, // Store decrypted locally for easy UI rendering
                lastNameEncrypted: decryptedLastName,
                dateOfBirth: r.date_of_birth,
                emailHashed: r.email_hashed,
                phoneEncrypted: decryptedPhone,
                createdAt: r.created_at,
                updatedAt: r.updated_at
              });
            }
          }

          // 3. Sync anamnesis
          const resAnamnesis = await executeQuery('SELECT id, patient_id, medical_diagnosis, surgical_history, allergies_cosmetics, current_medications, lifestyle_metrics, updated_at FROM anamnesis');
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
          const resConsults = await executeQuery('SELECT id, patient_id, provider_id, visit_date, skin_biotype, fitzpatrick_scale, skin_conditions, medical_diagnosis, clinical_notes, state, recommendations, allergies, medical_conditions FROM consultations');
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
                medicalConditions: r.medical_conditions || ''
              });
            }
          }

          // 5. Sync consultation steps
          const resSteps = await executeQuery('SELECT id, consultation_id, step_order, step_name, product_id, custom_product_name, custom_brand, custom_active_ingredients, custom_actions, application_description, aparatology_settings FROM consultation_steps');
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
          const resPrescriptions = await executeQuery('SELECT id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency, step_name, custom_product_name, custom_brand, custom_active_ingredients, custom_actions FROM prescriptions');
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

    // Load ingredients
    const iList = await db.products.toArray(); // map from physiological actions & ingredients
    const resolvedIngredients: { name: string; action: string }[] = [];
    pList.forEach(p => {
      try {
        const actives = JSON.parse(p.activeIngredients) as string[];
        const actions = JSON.parse(p.physiologicalActions) as string[];
        actives.forEach((act, idx) => {
          if (!resolvedIngredients.some(ri => ri.name.toLowerCase() === act.toLowerCase())) {
            resolvedIngredients.push({ name: act, action: actions[idx] || '' });
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

  // -----------------------------------------  // Ref to target clinical notes textarea directly for autofocus
  const notesTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // INTERACTIVE FACIAL CANVAS CANVAS
  // ----------------------------------------------------
  // Ref to cache preloaded backdrop image
  const backdropImageRef = useRef<HTMLImageElement | null>(null);
  const [isBackdropLoaded, setIsBackdropLoaded] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.src = `${import.meta.env.BASE_URL}face_backdrop.png?v=2`;
    img.onload = () => {
      backdropImageRef.current = img;
      setIsBackdropLoaded(true);
    };
    img.onerror = () => {
      console.error("Failed to load face backdrop image.");
    };
  }, []);

  useEffect(() => {
    if (!canvasRef.current || activeTab !== 'generator' || !isLogged) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    drawFacialSilhouette(ctx, canvas.width, canvas.height);
  }, [activeFacialZones, hoveredZone, mousePos, activeTab, isLogged, theme, isBackdropLoaded]);

  const drawFacialSilhouette = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const scaleX = width / 250;
    const scaleY = height / 250;

    const isDark = theme === 'dark';

    // 1. Draw preloaded premium 3D realistic face backdrop image
    if (backdropImageRef.current && isBackdropLoaded) {
      ctx.save();
      // Apply rounded clip matching container style
      ctx.beginPath();
      ctx.arc(cx, cy, 110 * scaleX, 0, Math.PI * 2);
      ctx.clip();
      
      // Draw background image
      ctx.drawImage(backdropImageRef.current, cx - 110 * scaleX, cy - 110 * scaleY, 220 * scaleX, 220 * scaleY);
      
      // Apply a subtle dark/light contrast mask overlay matching selected theme
      ctx.fillStyle = isDark ? 'rgba(10, 10, 13, 0.25)' : 'rgba(250, 249, 246, 0.1)';
      ctx.fillRect(cx - 110 * scaleX, cy - 110 * scaleY, 220 * scaleX, 220 * scaleY);
      ctx.restore();
    } else {
      // Elegant loading text state if image is buffering
      ctx.save();
      ctx.fillStyle = isDark ? '#FAF9F6' : '#222225';
      ctx.font = '10px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText("CARGANDO MAPA FACIAL 3D...", cx, cy);
      ctx.restore();
      return;
    }

    // 2. Interactive Zones Definitions (Coordinates aligned precisely to the graphic backdrop features)
    const zones: Record<string, { label: string; coords: [number, number, number] }> = {
      forehead: { label: 'Frente', coords: [cx, cy - 50 * scaleY, 28 * scaleX] },
      nose: { label: 'Nariz', coords: [cx, cy - 2 * scaleY, 18 * scaleX] },
      chin: { label: 'Mentón', coords: [cx, cy + 50 * scaleY, 20 * scaleX] },
      rightCheek: { label: 'Mejilla Der', coords: [cx + 40 * scaleX, cy + 12 * scaleY, 25 * scaleX] },
      leftCheek: { label: 'Mejilla Izq', coords: [cx - 40 * scaleX, cy + 12 * scaleY, 25 * scaleX] },
      rightEye: { label: 'Ojo Der', coords: [cx + 25 * scaleX, cy - 23 * scaleY, 15 * scaleX] },
      leftEye: { label: 'Ojo Izq', coords: [cx - 25 * scaleX, cy - 23 * scaleY, 15 * scaleX] },
      lips: { label: 'Labios', coords: [cx, cy + 26 * scaleY, 18 * scaleX] },
      neck: { label: 'Cuello', coords: [cx, cy + 82 * scaleY, 24 * scaleX] }
    };

    // 3. Render High Fidelity Interactive Golden Overlays
    Object.entries(zones).forEach(([key, val]) => {
      const isActive = activeFacialZones[key];
      const isHovered = hoveredZone === key;

      ctx.beginPath();
      ctx.arc(val.coords[0], val.coords[1], val.coords[2], 0, Math.PI * 2);

      if (isActive) {
        // High fidelity golden amber glow gradient
        const glowGrad = ctx.createRadialGradient(val.coords[0], val.coords[1], 2, val.coords[0], val.coords[1], val.coords[2]);
        glowGrad.addColorStop(0, 'rgba(212, 175, 55, 0.55)');
        glowGrad.addColorStop(0.7, 'rgba(212, 175, 55, 0.35)');
        glowGrad.addColorStop(1, 'rgba(212, 175, 55, 0.05)');
        ctx.fillStyle = glowGrad;
        ctx.strokeStyle = '#D4AF37';
        ctx.lineWidth = 2.5;
      } else if (isHovered) {
        ctx.fillStyle = 'rgba(212, 175, 55, 0.15)';
        ctx.strokeStyle = 'rgba(212, 175, 55, 0.6)';
        ctx.lineWidth = 1.5;
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0)';
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(181, 144, 43, 0.06)';
        ctx.lineWidth = 1;
      }

      ctx.fill();
      ctx.stroke();

      // Elegant subtle clinical reticle indicator instead of big text labels
      ctx.save();
      ctx.beginPath();
      ctx.arc(val.coords[0], val.coords[1], 4 * scaleX, 0, Math.PI * 2);
      if (isActive) {
        ctx.fillStyle = '#D4AF37';
        ctx.strokeStyle = '#FAF9F6';
        ctx.lineWidth = 1.5;
      } else if (isHovered) {
        ctx.fillStyle = 'rgba(212, 175, 55, 0.9)';
        ctx.strokeStyle = '#D4AF37';
        ctx.lineWidth = 1;
      } else {
        ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(181, 144, 43, 0.25)';
        ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(181, 144, 43, 0.45)';
        ctx.lineWidth = 0.8;
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });

    // 4. Elegant floating tooltip for hovered zone
    if (hoveredZone && zones[hoveredZone]) {
      const zone = zones[hoveredZone];
      const isZoneActive = activeFacialZones[hoveredZone];
      ctx.save();
      
      const text = `${zone.label.toUpperCase()} ${isZoneActive ? '(ACTIVO - CLIC PARA QUITAR)' : '(CLIC PARA SELECCIONAR)'}`;
      ctx.font = 'bold 9px Sora, system-ui, sans-serif';
      const textWidth = ctx.measureText(text).width;
      
      const rectW = textWidth + 16;
      const rectH = 20;
      // Position tooltip near mouse cursor
      const rx = Math.max(10, Math.min(width - rectW - 10, mousePos.x - rectW / 2));
      const ry = Math.max(10, Math.min(height - rectH - 10, mousePos.y - 30));
      
      // Draw rounded rectangle background (glassmorphism look)
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(rx, ry, rectW, rectH, 6);
      } else {
        ctx.rect(rx, ry, rectW, rectH);
      }
      ctx.fillStyle = 'rgba(18, 18, 21, 0.9)';
      ctx.strokeStyle = 'rgba(212, 175, 55, 0.8)';
      ctx.lineWidth = 1;
      ctx.fill();
      ctx.stroke();
      
      // Draw text
      ctx.fillStyle = '#FAF9F6';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, rx + rectW / 2, ry + rectH / 2);
      ctx.restore();
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvasRef.current.width / rect.width);
    const y = (e.clientY - rect.top) * (canvasRef.current.height / rect.height);

    const cx = canvasRef.current.width / 2;
    const cy = canvasRef.current.height / 2;
    const scaleX = canvasRef.current.width / 250;
    const scaleY = canvasRef.current.height / 250;

    const zones: Record<string, { label: string; coords: [number, number, number] }> = {
      forehead: { label: 'Frente', coords: [cx, cy - 50 * scaleY, 28 * scaleX] },
      nose: { label: 'Nariz', coords: [cx, cy - 2 * scaleY, 18 * scaleX] },
      chin: { label: 'Mentón', coords: [cx, cy + 50 * scaleY, 20 * scaleX] },
      rightCheek: { label: 'Mejilla Der', coords: [cx + 40 * scaleX, cy + 12 * scaleY, 25 * scaleX] },
      leftCheek: { label: 'Mejilla Izq', coords: [cx - 40 * scaleX, cy + 12 * scaleY, 25 * scaleX] },
      rightEye: { label: 'Ojo Der', coords: [cx + 25 * scaleX, cy - 23 * scaleY, 15 * scaleX] },
      leftEye: { label: 'Ojo Izq', coords: [cx - 25 * scaleX, cy - 23 * scaleY, 15 * scaleX] },
      lips: { label: 'Labios', coords: [cx, cy + 26 * scaleY, 18 * scaleX] },
      neck: { label: 'Cuello', coords: [cx, cy + 82 * scaleY, 24 * scaleX] }
    };

    let clickedKey: string | null = null;
    let clickedLabel = '';
    for (const [key, val] of Object.entries(zones)) {
      if (Math.hypot(x - val.coords[0], y - val.coords[1]) < val.coords[2]) {
        clickedKey = key;
        clickedLabel = val.label;
        break;
      }
    }

    if (clickedKey) {
      setActiveFacialZones(prev => {
        const nextState = { ...prev, [clickedKey!]: !prev[clickedKey!] };
        const isActivating = nextState[clickedKey!];
        
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
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvasRef.current.width / rect.width);
    const y = (e.clientY - rect.top) * (canvasRef.current.height / rect.height);

    const cx = canvasRef.current.width / 2;
    const cy = canvasRef.current.height / 2;
    const scaleX = canvasRef.current.width / 250;
    const scaleY = canvasRef.current.height / 250;

    const zones: Record<string, [number, number, number]> = {
      forehead: [cx, cy - 50 * scaleY, 28 * scaleX],
      nose: [cx, cy - 2 * scaleY, 18 * scaleX],
      chin: [cx, cy + 50 * scaleY, 20 * scaleX],
      rightCheek: [cx + 40 * scaleX, cy + 12 * scaleY, 25 * scaleX],
      leftCheek: [cx - 40 * scaleX, cy + 12 * scaleY, 25 * scaleX],
      rightEye: [cx + 25 * scaleX, cy - 23 * scaleY, 15 * scaleX],
      leftEye: [cx - 25 * scaleX, cy - 23 * scaleY, 15 * scaleX],
      lips: [cx, cy + 26 * scaleY, 18 * scaleX],
      neck: [cx, cy + 82 * scaleY, 24 * scaleX]
    };

    let foundZone: string | null = null;
    for (const [key, val] of Object.entries(zones)) {
      if (Math.hypot(x - val[0], y - val[1]) < val[2]) {
        foundZone = key;
        break;
      }
    }

    setMousePos({ x, y });
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
    const matches = products.filter(p => p.name.toLowerCase().includes(val.toLowerCase()) || p.brandLine.toLowerCase().includes(val.toLowerCase())).slice(0, 5);
    setPresSuggestions(matches);
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

    setPresInput(prev => ({
      ...prev,
      productId: p.id,
      customProductName: p.name,
      customBrand: p.brandLine,
      customActiveIngredients: actives,
      customActions: actions
    }));
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
      // 1. Compute Cryptography for PHI locally (Web Crypto API)
      const firstNameEnc = await encryptData(patientForm.firstName);
      const lastNameEnc = await encryptData(patientForm.lastName);
      const phoneEnc = await encryptData(patientForm.phone);
      const patientId = selectedPatientId || `P-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
      const emailH = await sha256(patientForm.email || `${patientForm.firstName}.${patientForm.lastName}.${patientId}@clinical.local`);

      const consultationId = activeConsultationId || `C-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

      // Register patient on remote if online
      if (navigator.onLine) {
        try {
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
        } catch (remoteErr) {
          console.warn("Fallo al registrar paciente en Turso, se continuará localmente:", remoteErr);
        }
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
        state: patientForm.state,
        allergies: patientForm.allergies || '',
        medicalConditions: patientForm.medicalConditions || '',
        recommendations: patientForm.recommendations || ''
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
      resetPatientForm();
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
      setSelectedPatientId('');
      setActiveConsultationId('');
      resetPatientForm();
      return;
    }

    const pat = patients.find(p => p.id === patientId);
    if (!pat) return;

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

    if (latestConsultation) {
      const steps = await db.consultation_steps.where('consultationId').equals(latestConsultation.id).toArray();
      const prescriptions = await db.prescriptions.where('consultationId').equals(latestConsultation.id).toArray();
      
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

      showToastMsg(`Historial de ${pat.firstNameEncrypted} cargado: se copiaron datos y protocolo de la última sesión.`, 'success');
    } else {
      setCurrentSteps([]);
      setPrescriptionsList([]);
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

  const handleDeleteConsultation = async (consultationId: string, patientId: string) => {
    if (!window.confirm('¿Está seguro de que desea eliminar permanentemente esta sesión de consulta/visita? Esta acción no se puede deshacer.')) {
      return;
    }
    try {
      // 1. Delete from local Dexie
      await db.consultations.delete(consultationId);
      await db.consultation_steps.where('consultationId').equals(consultationId).delete();
      await db.prescriptions.where('consultationId').equals(consultationId).delete();

      // 2. Delete from Turso if online
      try {
        await executeQuery('DELETE FROM consultations WHERE id = ?', [consultationId]);
        await executeQuery('DELETE FROM consultation_steps WHERE consultation_id = ?', [consultationId]);
        await executeQuery('DELETE FROM prescriptions WHERE consultation_id = ?', [consultationId]);
      } catch (err) {
        console.warn('Fallo al eliminar de Turso, se reintentará en la sincronización:', err);
      }

      showToastMsg('Visita eliminada correctamente.', 'success');
      
      // If the deleted consultation was the active one, clear active session
      if (activeConsultationId === consultationId) {
        setActiveConsultationId('');
        resetPatientForm();
      }
      
      await loadMasterCatalogs(); // Refresh state lists
    } catch (e) {
      console.error(e);
      showToastMsg('Error al eliminar la visita.', 'error');
    }
  };

  const handleDeletePatient = async (patientId: string) => {
    if (!window.confirm('¿Está seguro de que desea eliminar este paciente? Se borrará su expediente completo, incluyendo TODAS las consultas, prescripciones e historial clínico de forma permanente.')) {
      return;
    }
    try {
      // Get all consultations for this patient
      const consultationsToDelete = records.filter(r => r.patientId === patientId);

      // 1. Delete from local Dexie
      await db.patients.delete(patientId);
      await db.anamnesis.where('patientId').equals(patientId).delete();
      for (const c of consultationsToDelete) {
        await db.consultations.delete(c.id);
        await db.consultation_steps.where('consultationId').equals(c.id).delete();
        await db.prescriptions.where('consultationId').equals(c.id).delete();
      }

      // 2. Delete from Turso if online
      try {
        await executeQuery('DELETE FROM patients WHERE id = ?', [patientId]);
        await executeQuery('DELETE FROM anamnesis WHERE patient_id = ?', [patientId]);
        for (const c of consultationsToDelete) {
          await executeQuery('DELETE FROM consultations WHERE id = ?', [c.id]);
          await executeQuery('DELETE FROM consultation_steps WHERE consultation_id = ?', [c.id]);
          await executeQuery('DELETE FROM prescriptions WHERE consultation_id = ?', [c.id]);
        }
      } catch (err) {
        console.warn('Fallo al eliminar del servidor Turso:', err);
      }

      showToastMsg('Expediente del paciente eliminado correctamente.', 'success');
      
      // If the active patient was this one, clear active patient
      if (selectedPatientId === patientId) {
        setSelectedPatientId('');
        setActiveConsultationId('');
        resetPatientForm();
      }
      await loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al eliminar el expediente del paciente.', 'error');
    }
  };

  const resetPatientForm = () => {
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
      recommendations: ''
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
        medicalConditions: patientForm.medicalConditions || ''
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
      recommendations: c.recommendations || ''
    });

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
      retailPrice: String(p.retailPrice),
      isProfessionalUse: p.isProfessionalUse,
      activeIngredients: p.activeIngredients,
      physiologicalActions: p.physiologicalActions,
      skinBiotypes: p.skinBiotypes || '[]'
    });
    setFormIngredientsList(parsedActives);
  };

  const handleDeleteProduct = async (id: string) => {
    if (!window.confirm('¿Está seguro de eliminar este producto del catálogo?')) return;
    try {
      if (navigator.onLine) {
        await executeQuery('DELETE FROM products WHERE id = ?', [id]);
      }
      await db.products.delete(id);
      showToastMsg('Producto eliminado del catálogo.', 'success');
      loadMasterCatalogs();
    } catch (e) {
      console.error(e);
      showToastMsg('Error al eliminar producto.', 'error');
    }
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
      physiologicalActions: JSON.stringify(actions),
      skinBiotypes: productForm.skinBiotypes || '[]'
    };

    if (navigator.onLine) {
      await executeQuery(
        `INSERT OR REPLACE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use, skin_biotypes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newProd.id, newProd.sku, newProd.name, newProd.brandLine, newProd.activeIngredients, newProd.physiologicalActions, newProd.retailPrice, typeof newProd.isProfessionalUse === 'boolean' ? (newProd.isProfessionalUse ? 1 : 0) : Number(newProd.isProfessionalUse), newProd.skinBiotypes]
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

  const getMatchingProductsForStep = (step: RoutineStepTemplate): Product[] => {
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
  };

  const applySelectedRoutineToPatient = () => {
    if (!selectedPatientId) {
      showToastMsg('Por favor seleccione o cree un paciente primero.', 'error');
      return;
    }
    const routine = ESTABLISHED_ROUTINES[selectedRoutineTx];
    if (!routine) return;
    const steps = selectedRoutineTime === 'Dia' ? routine.Dia : routine.Noche;
    
    const newPrescriptions: Prescription[] = steps.map((step, index) => {
      const selectionKey = `${selectedRoutineTx}_${selectedRoutineTime}_${index}`;
      const selectedValue = routineStepSelections[selectionKey] || 'default';
      
      let pId: string | undefined = undefined;
      let pName = step.defaultProductName;
      let pBrand = step.defaultBrand;
      let pActives = step.defaultActiveIngredients;
      let pActions = step.defaultActions;
      let prodDetails: Product | undefined = undefined;

      if (selectedValue !== 'default') {
        const found = products.find(p => p.id === selectedValue);
        if (found) {
          pId = found.id;
          pName = found.name;
          pBrand = found.brandLine;
          
          try {
            const parsed = JSON.parse(found.activeIngredients || '[]');
            pActives = Array.isArray(parsed) ? parsed.join(', ') : found.activeIngredients;
          } catch(e) {
            pActives = found.activeIngredients;
          }

          try {
            const parsed = JSON.parse(found.physiologicalActions || '[]');
            pActions = Array.isArray(parsed) ? parsed.join(', ') : found.physiologicalActions;
          } catch(e) {
            pActions = found.physiologicalActions;
          }
          prodDetails = found;
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
        productDetails: prodDetails
      };
    });

    setPrescriptionsList(prev => [...prev, ...newPrescriptions]);
    showToastMsg(`Rutina ${selectedRoutineTx} (${selectedRoutineTime === 'Dia' ? 'Día' : 'Noche'}) agregada al protocolo de apoyo.`, 'success');
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

      setUploadPreview(parsedProducts);
      showToastMsg(`Previsualizando ${parsedProducts.length} productos extraídos del PDF.`, 'success');
    } catch (e: any) {
      console.error(e);
      showToastMsg(e.message || 'Error al procesar el archivo PDF.', 'error');
    }
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

      const mapped: Product[] = json.map((row, idx) => ({
        id: `EXCEL-${idx}-${Math.floor(Math.random() * 1000)}`,
        sku: row.SKU || `SKU-${idx}`,
        name: row.Nombre || row.Producto || 'Insumo importado',
        brandLine: row.Marca || 'Genérico',
        retailPrice: parseFloat(row.Precio) || 0,
        isProfessionalUse: row.UsoProfesional === 'Ambos' || row.UsoProfesional === 2 || String(row.UsoProfesional).toLowerCase().includes('ambos') ? 2 : (row.UsoProfesional === 'Sí' || row.UsoProfesional === 1 || String(row.UsoProfesional).toLowerCase().includes('cabina') || String(row.UsoProfesional).toLowerCase().includes('sí') ? 1 : 0),
        activeIngredients: JSON.stringify(row.Activos ? String(row.Activos).split(',') : []),
        physiologicalActions: JSON.stringify(row.Acciones ? String(row.Acciones).split(',') : []),
        skinBiotypes: JSON.stringify(row.Biotipos ? String(row.Biotipos).split(',') : [])
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
            `INSERT OR REPLACE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use, skin_biotypes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [p.id, p.sku, p.name, p.brandLine, p.activeIngredients, p.physiologicalActions, p.retailPrice, typeof p.isProfessionalUse === 'boolean' ? (p.isProfessionalUse ? 1 : 0) : Number(p.isProfessionalUse), p.skinBiotypes || '[]']
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
                  {/* Clinical Workflow Phases Controller */}
                  <div className="flex flex-col items-end">
                    <span className="text-[9px] font-extrabold uppercase text-slate-400 dark:text-luxe-400 tracking-widest mb-1">Fase del Proceso Clínico</span>
                    <div className="flex gap-1.5 bg-slate-100 dark:bg-white/5 p-1.5 rounded-2xl border border-slate-200/50 dark:border-white/5 relative group">
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
                            className={`px-3 py-1.5 rounded-xl text-[10px] font-bold tracking-wider uppercase transition-all relative ${
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
                        Estás modificando la sesión ID <strong className="font-mono">{activeConsultationId}</strong>. Los cambios reemplazarán el registro anterior al guardar.
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
              <form onSubmit={handleSaveConsultation} className="space-y-6">
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
                        {[...patients].sort((a,b) => a.firstNameEncrypted.localeCompare(b.firstNameEncrypted)).map(p => (
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
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Protocolo</label>
                    <input type="text" value={patientForm.medicalDiagnosis} onChange={e => setPatientForm(prev => ({ ...prev, medicalDiagnosis: e.target.value }))} placeholder="P. ej., Limpieza profunda, Peeling..." className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Alergias</label>
                    <input type="text" value={patientForm.allergies} onChange={e => setPatientForm(prev => ({ ...prev, allergies: e.target.value }))} placeholder="P. ej., Alergia al látex, fragancias, cosméticos..." className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Condiciones Médicas</label>
                    <input type="text" value={patientForm.medicalConditions} onChange={e => setPatientForm(prev => ({ ...prev, medicalConditions: e.target.value }))} placeholder="P. ej., Diabetes, embarazo, hipertensión..." className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                  </div>
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
                        <div className="mt-4 flex flex-col gap-2 animate-fade-in">
                          <label className="text-[9px] font-bold text-amber-500 dark:text-amber-400 uppercase tracking-widest ml-1">Especifique Otra Condición</label>
                          <input type="text" value={customConditionInput} onChange={e => handleCustomConditionChange(e.target.value)} placeholder="Describa la condición de la piel..." className="smart-input w-full px-4 py-3 rounded-xl text-sm" />
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>

                {/* Facial Canvas Map */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Notas Clínicas SOAP / Zonas Afectadas</label>
                    <textarea ref={notesTextareaRef} value={patientForm.clinicalNotes} onChange={e => setPatientForm(prev => ({ ...prev, clinicalNotes: e.target.value }))} rows={8} placeholder="Diagnóstico de cabina y observaciones clínicas..." required className="smart-input w-full p-4 rounded-xl text-sm resize-none" />
                  </div>
                  
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Mapa Facial Clínico Interactivo</label>
                    <div className="liquid-glass-light rounded-[24px] p-4 flex items-center justify-center border border-slate-200/50 dark:border-white/5 min-h-[220px]">
                      <canvas ref={canvasRef} width={250} height={250} onClick={handleCanvasClick} onMouseMove={handleCanvasMouseMove} className="cursor-pointer max-w-full max-h-full" />
                    </div>
                  </div>
                </div>

                {/* Recomendaciones y Sugerencias de Apoyo */}
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">Recomendaciones y Sugerencias de Apoyo (Opcional - Rutinas de lavado, hábitos, etc.)</label>
                  <textarea value={patientForm.recommendations} onChange={e => setPatientForm(prev => ({ ...prev, recommendations: e.target.value }))} rows={4} placeholder="Escribe aquí sugerencias opcionales de cuidado en casa, tipos de rutinas de lavado, frecuencia de mantenimiento, etc..." className="smart-input w-full p-4 rounded-xl text-sm resize-none" />
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
                        {stepInput.stepName === 'Otro' && (
                          <input type="text" value={stepInput.customStepName} onChange={e => setStepInput(prev => ({ ...prev, customStepName: e.target.value }))} placeholder="Especificar Fase/Protocolo..." className="smart-input w-full mt-2" />
                        )}
                      </div>
                    </div>

                    <div className="lg:col-span-7 space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <input type="text" value={stepInput.customProductName} onChange={e => setStepInput(prev => ({ ...prev, customProductName: e.target.value }))} placeholder="Nombre del Producto..." className="smart-input w-full" />
                        <input type="text" value={stepInput.customBrand} onChange={e => setStepInput(prev => ({ ...prev, customBrand: e.target.value }))} placeholder="Marca/Línea..." className="smart-input w-full" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <input type="text" value={stepInput.customActiveIngredients} onChange={e => setStepInput(prev => ({ ...prev, customActiveIngredients: e.target.value }))} placeholder="Activos Clave..." className="smart-input w-full" />
                        <input type="text" value={stepInput.customActions} onChange={e => setStepInput(prev => ({ ...prev, customActions: e.target.value }))} placeholder="Acción / Efecto Clínico..." className="smart-input w-full" />
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

                  {/* List of Added Steps */}
                  <div className="border border-slate-200/50 dark:border-white/5 rounded-2xl overflow-hidden bg-white/40 dark:bg-luxe-950/20">
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
                        {currentSteps.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="py-6 text-center text-slate-400 italic">No se han añadido pasos.</td>
                          </tr>
                        ) : (
                          currentSteps.map((step, idx) => (
                            <tr key={step.id}>
                              <td className="py-3 px-4">{step.stepOrder}</td>
                              <td className="py-3 px-4 font-bold">{step.stepName}</td>
                              <td className="py-3 px-4">
                                {(() => {
                                  const nameLower = (step.customProductName || '').toLowerCase();
                                  if (nameLower === 'sin producto' || !step.customProductName) {
                                    if (step.aparatologySettings) {
                                      try {
                                        const parsed = JSON.parse(step.aparatologySettings);
                                        if (Array.isArray(parsed) && parsed.length > 0) {
                                          return <span className="text-bronze-600 dark:text-bronze-400 font-medium">Aparatología: {parsed.join(', ')}</span>;
                                        }
                                      } catch(e) {}
                                      return <span className="text-bronze-600 dark:text-bronze-400 font-medium">Aparatología: {step.aparatologySettings}</span>;
                                    }
                                  }
                                  return step.customProductName;
                                })()}
                              </td>
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
                          ))
                        )}
                      </tbody>
                    </table>
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

                {/* Protocolos de Apoyo en Casa */}
                <div className="liquid-glass-light rounded-2xl p-6 border border-slate-200/50 dark:border-white/5 space-y-6">
                  <h3 className="font-outfit text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                    <Wand2 className="w-4 h-4 text-amber-500" />
                    Diseñador de Protocolo de Apoyo en Casa
                  </h3>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 bg-slate-500/5 p-6 rounded-[24px] border border-slate-200/20 animate-fade-in">
                    <div className="lg:col-span-5 space-y-4 flex flex-col justify-between">
                      <div className="flex flex-col gap-2 relative">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Buscar Producto de Apoyo</label>
                        <input type="text" value={presSearchQuery} onChange={e => handlePresProductSearch(e.target.value)} placeholder="🔍 Escriba para buscar en catálogo..." className="smart-input w-full" />
                        {presSuggestions.length > 0 && (
                          <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-luxe-900 shadow-xl max-h-52 overflow-y-auto">
                            {presSuggestions.map(p => (
                              <div key={p.id} onClick={() => selectPresSearchProduct(p)} className="p-2.5 hover:bg-slate-100 dark:hover:bg-white/5 border-b border-slate-100 dark:border-white/5 last:border-0 cursor-pointer text-xs">
                                <span className="font-bold text-slate-800 dark:text-white">{p.name} ({p.brandLine})</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Fase / Protocolo de Apoyo</label>
                        <select value={presInput.stepName} onChange={e => setPresInput(prev => ({ ...prev, stepName: e.target.value }))} className="smart-input w-full">
                          <option value="Limpieza">Limpieza / Higiene</option>
                          <option value="Tonificación">Tonificación / Loción</option>
                          <option value="Suero / Activo">Suero / Activo Concentrado</option>
                          <option value="Crema de Día">Crema de Día</option>
                          <option value="Crema de Noche">Crema de Noche</option>
                          <option value="Contorno de Ojos">Contorno de Ojos</option>
                          <option value="Protección Solar">Protección Solar</option>
                          <option value="Mascarilla">Mascarilla Semanal</option>
                          <option value="Exfoliación">Exfoliación Semanal</option>
                          <option value="Otro">Otro</option>
                        </select>
                        {presInput.stepName === 'Otro' && (
                          <input type="text" value={presInput.customStepName} onChange={e => setPresInput(prev => ({ ...prev, customStepName: e.target.value }))} placeholder="Especificar Fase/Protocolo..." className="smart-input w-full mt-2" />
                        )}
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Horario de Uso</label>
                        <select value={presInput.timeOfDay} onChange={e => setPresInput(prev => ({ ...prev, timeOfDay: e.target.value as any }))} className="smart-input w-full">
                          <option value="Dia">Día</option>
                          <option value="Noche">Noche</option>
                          <option value="Dia y Noche">Día y Noche</option>
                        </select>
                      </div>
                    </div>

                    <div className="lg:col-span-7 space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <input type="text" value={presInput.customProductName} onChange={e => setPresInput(prev => ({ ...prev, customProductName: e.target.value }))} placeholder="Nombre del Producto..." className="smart-input w-full" />
                        <input type="text" value={presInput.customBrand} onChange={e => setPresInput(prev => ({ ...prev, customBrand: e.target.value }))} placeholder="Marca/Línea..." className="smart-input w-full" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <input type="text" value={presInput.customActiveIngredients} onChange={e => setPresInput(prev => ({ ...prev, customActiveIngredients: e.target.value }))} placeholder="Activos Clave..." className="smart-input w-full" />
                        <input type="text" value={presInput.customActions} onChange={e => setPresInput(prev => ({ ...prev, customActions: e.target.value }))} placeholder="Acción / Efecto Clínico..." className="smart-input w-full" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <input type="text" value={presInput.dosageInstructions} onChange={e => setPresInput(prev => ({ ...prev, dosageInstructions: e.target.value }))} placeholder="Instrucciones clínicas..." className="smart-input w-full" />
                        <input type="text" value={presInput.applicationFrequency} onChange={e => setPresInput(prev => ({ ...prev, applicationFrequency: e.target.value }))} placeholder="Frecuencia de aplicación..." className="smart-input w-full" />
                      </div>

                      {editingPrescriptionIndex !== null ? (
                        <div className="flex gap-2">
                          <button type="button" onClick={handleAddPrescription} className="flex-1 bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md">
                            Guardar Cambios
                          </button>
                          <button type="button" onClick={cancelEditPrescription} className="px-4 bg-slate-200 hover:bg-slate-300 dark:bg-white/10 dark:hover:bg-white/20 text-slate-700 dark:text-luxe-200 py-2.5 rounded-xl text-xs font-semibold transition-all">
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={handleAddPrescription} className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md">
                          <Plus className="w-4 h-4" /> Agregar al Protocolo de Apoyo
                        </button>
                      )}
                    </div>
                  </div>

                  {/* List of Added Prescriptions */}
                  <div className="border border-slate-200/50 dark:border-white/5 rounded-2xl overflow-hidden bg-white/40 dark:bg-luxe-950/20">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-100/60 dark:bg-white/5 border-b border-slate-200/50 dark:border-white/5 text-[10px] font-bold uppercase tracking-wider">
                          <th className="py-3 px-4">Protocolo</th>
                          <th className="py-3 px-4">Producto</th>
                          <th className="py-3 px-4">Marca</th>
                          <th className="py-3 px-4">Activos</th>
                          <th className="py-3 px-4">Instrucciones / Horario</th>
                          <th className="py-3 px-4 text-right">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                        {prescriptionsList.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-6 text-center text-slate-400 italic">No hay productos agregados al protocolo de apoyo.</td>
                          </tr>
                        ) : (
                          prescriptionsList.map((pres, idx) => (
                            <tr key={pres.id}>
                              <td className="py-3 px-4 font-bold">{pres.stepName}</td>
                              <td className="py-3 px-4 font-semibold">{pres.customProductName || pres.productDetails?.name}</td>
                              <td className="py-3 px-4">{pres.customBrand || pres.productDetails?.brandLine}</td>
                              <td className="py-3 px-4 truncate max-w-[150px]">{pres.customActiveIngredients || 'N/A'}</td>
                              <td className="py-3 px-4">
                                <span className="font-semibold text-amber-600 dark:text-amber-400">{pres.timeOfDay}</span> ({pres.applicationFrequency}) - {pres.dosageInstructions}
                              </td>
                              <td className="py-3 px-4 text-right space-x-2">
                                <button type="button" onClick={() => movePrescriptionUp(idx)} disabled={idx === 0} className={`inline-flex items-center gap-1 text-[11px] ${idx === 0 ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-600 dark:text-luxe-300 hover:text-amber-500'}`} title="Subir">▲</button>
                                <button type="button" onClick={() => movePrescriptionDown(idx)} disabled={idx === prescriptionsList.length - 1} className={`inline-flex items-center gap-1 text-[11px] ${idx === prescriptionsList.length - 1 ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-600 dark:text-luxe-300 hover:text-amber-500'}`} title="Bajar">▼</button>
                                <button type="button" onClick={() => editPrescription(idx)} className="text-bronze-600 dark:text-bronze-400 hover:underline inline-flex items-center gap-1" title="Editar"><Pencil className="w-3.5 h-3.5" /></button>
                                <button type="button" onClick={() => removePrescription(idx)} className="text-red-500 hover:underline inline-flex items-center gap-1" title="Eliminar"><Trash2 className="w-3.5 h-3.5" /></button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
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
                  <h3 className="text-xs font-bold text-slate-700 dark:text-white uppercase tracking-wider">
                    Detalle de la Rutina: {selectedRoutineTx} ({selectedRoutineTime === 'Dia' ? 'Día' : 'Noche'})
                  </h3>

                  <div className="space-y-4 divide-y divide-slate-200/10">
                    {(() => {
                      const routine = ESTABLISHED_ROUTINES[selectedRoutineTx];
                      if (!routine) return <p className="text-xs text-slate-400 italic">No se encontró la rutina.</p>;
                      const steps = selectedRoutineTime === 'Dia' ? routine.Dia : routine.Noche;

                      return steps.map((step, idx) => {
                        const selectionKey = selectedRoutineTx + "_" + selectedRoutineTime + "_" + String(idx);
                        const selectedVal = routineStepSelections[selectionKey] || 'default';
                        const matches = getMatchingProductsForStep(step);

                        return (
                          <div key={idx} className="pt-4 first:pt-0 grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="space-y-1">
                              <span className="inline-block bg-amber-550/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                                {step.stepName}
                              </span>
                              <h4 className="text-xs font-bold text-slate-800 dark:text-white mt-1">{step.defaultProductName}</h4>
                              <p className="text-[10px] text-slate-400 italic">{step.defaultBrand} - {step.defaultActiveIngredients}</p>
                            </div>
                            
                            <div className="text-[11px] text-slate-650 dark:text-luxe-200 space-y-1 self-center">
                              <p><strong>Frecuencia:</strong> {step.applicationFrequency}</p>
                              <p className="text-[10.5px]"><strong>Indicación:</strong> {step.dosageInstructions}</p>
                            </div>

                            <div className="flex flex-col justify-center gap-1.5">
                              <label className="text-[9px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-wider">Asociar Producto del Catálogo</label>
                              <select
                                value={selectedVal}
                                onChange={e => {
                                  const val = e.target.value;
                                  setRoutineStepSelections(prev => ({
                                    ...prev,
                                    [selectionKey]: val
                                  }));
                                }}
                                className="smart-input w-full text-xs py-1.5"
                              >
                                <option value="default">✨ Recomendación por defecto</option>
                                {matches.map(p => (
                                  <option key={p.id} value={p.id}>
                                    📦 {p.name} ({p.brandLine})
                                  </option>
                                ))}
                                {matches.length === 0 && (
                                  <option disabled>⚠️ No hay productos con palabras clave similares</option>
                                )}
                              </select>
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
                setProductForm({ id: '', sku: '', name: '', brandLine: '', retailPrice: '', isProfessionalUse: 1, activeIngredients: '[]', physiologicalActions: '[]' });
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
                        {['Piel Mixta', 'Piel Alípica', 'Piel Grasa', 'Piel Eudermica', 'Sensible', 'Rosácea', 'Todo tipo de piel', 'Protocolos específicos', 'Madura', 'Hipercromias', 'Deshidratada', 'Acneica', 'Delicada', 'Antiagning', 'Desvitalizada', 'Sensibilizada'].map(bio => {
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
                    </div>
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
                            <span>{ing.name}{ing.action ? ` (${ing.action})` : ''}</span>
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
                      <th className="py-3.5 px-4 font-bold">Biotipos</th>
                      <th className="py-3.5 px-4 text-right font-bold">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                    {products
                      .filter(p => {
                        const searchLower = catalogSearch.toLowerCase();
                        let actives = '';
                        try {
                          actives = JSON.parse(p.activeIngredients).join(', ').toLowerCase();
                        } catch(e) {
                          actives = p.activeIngredients.toLowerCase();
                        }
                        return p.name.toLowerCase().includes(searchLower) ||
                               p.brandLine.toLowerCase().includes(searchLower) ||
                               actives.includes(searchLower);
                      })
                      .map(p => {
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
                        return (
                          <tr key={p.id}>
                            <td className="py-3.5 px-4">{p.sku}</td>
                            <td className="py-3.5 px-4 font-bold">{p.name}</td>
                            <td className="py-3.5 px-4">{p.brandLine}</td>
                            <td className="py-3.5 px-4">${p.retailPrice.toFixed(2)} MXN</td>
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

            {/* Bulk File upload */}
            <div className="liquid-glass rounded-3xl p-8">
              <h2 className="font-outfit text-xl font-bold text-slate-800 dark:text-white mb-2">Importación de Catálogo</h2>
              <p className="text-slate-500 dark:text-luxe-300 text-xs mb-6">Arrastra y suelta tu archivo Excel o PDF del catálogo para actualizar masivamente el inventario.</p>

              <div className="border-2 border-dashed border-slate-300 dark:border-white/10 hover:border-bronze-500/50 rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer bg-slate-50/50 dark:bg-white/[0.01] hover:bg-bronze-500/[0.02] relative">
                <input type="file" accept=".xlsx, .xls, .pdf" onChange={handleExcelUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                <FileUp className="w-10 h-10 text-bronze-500 mb-4" />
                <p className="text-xs font-semibold">Selecciona o arrastra tu archivo Excel (.xlsx, .xls) o PDF (.pdf)</p>
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
                // Group records by patientId
                const groupedRecords = records.reduce((acc, curr) => {
                  if (!acc[curr.patientId]) {
                    acc[curr.patientId] = [];
                  }
                  acc[curr.patientId].push(curr);
                  return acc;
                }, {} as Record<string, Consultation[]>);

                // Filter patients
                const filteredPatients = patients.filter(pat => {
                  const fullName = `${pat.firstNameEncrypted} ${pat.lastNameEncrypted}`.toLowerCase();
                  const phone = (pat.phoneEncrypted || '').toLowerCase();
                  const matchesSearch = fullName.includes(folderSearchQuery.toLowerCase()) || phone.includes(folderSearchQuery.toLowerCase());

                  const patConsultations = groupedRecords[pat.id] || [];
                  const latestConsultation = patConsultations.sort((a, b) => new Date(b.visitDate).getTime() - new Date(a.visitDate).getTime())[0];
                  
                  const matchesBiotype = !folderBiotypeFilter || (latestConsultation && latestConsultation.skinBiotype === folderBiotypeFilter);

                  return matchesSearch && matchesBiotype;
                });

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
                                  <span className="block text-[9px] text-slate-400 uppercase">Condiciones Médicas</span>
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
                                        <span>Escala Fitzpatrick: <strong>{consultation.fitzpatrickScale}</strong></span>
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
    </div>
  );
}
