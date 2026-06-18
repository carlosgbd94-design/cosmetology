export type ConsultationState = 'Borrador' | 'Admision' | 'Consentimiento' | 'Tratamiento' | 'Evaluacion';

export interface Patient {
  id: string;
  firstNameEncrypted: string; // AES-256 base64
  lastNameEncrypted: string;  // AES-256 base64
  dateOfBirth: string;        // YYYY-MM-DD
  emailHashed: string;        // SHA-256
  phoneEncrypted: string;      // AES-256 base64
  createdAt: string;
  updatedAt: string;
}

export interface Anamnesis {
  id: string;
  patientId: string;
  medicalDiagnosis?: string; // Diagnóstico médico (p. ej., Dermatitis atópica)
  surgicalHistory?: string;
  allergiesCosmetics: string; // JSON string que almacena string[]
  currentMedications: string; // JSON string que almacena string[]
  lifestyleMetrics: string;   // JSON string que almacena un objeto con hábitos
  updatedAt: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  brandLine: string;
  activeIngredients: string; // JSON string que almacena string[]
  physiologicalActions: string; // JSON string que almacena string[]
  retailPrice: number;
  isProfessionalUse: boolean;
  skinBiotypes?: string; // JSON string que almacena string[]
}

export interface ConsultationStep {
  id: string;
  consultationId: string;
  stepOrder: number;
  stepName: string; // Fase (p. ej., "Armonizador", "Shampoo", "Loción", "Exfoliación")
  productId?: string;
  productDetails?: Product; // Joineado desde el backend si aplica
  customProductName?: string; // Nombre del producto manual
  customBrand?: string; // Marca manual
  customActiveIngredients?: string; // Activos manuales
  customActions?: string; // Acción manual
  applicationDescription?: string; // Descripción técnica de la aplicación
  aparatologySettings?: string; // JSON string
}

export interface Prescription {
  id: string;
  consultationId: string;
  productId: string;
  productDetails?: Product; // Joineado desde el backend si aplica
  timeOfDay: 'Dia' | 'Noche' | 'Dia y Noche';
  dosageInstructions: string;
  applicationFrequency: string;
}

export interface Consultation {
  id: string;
  patientId: string;
  providerId: string;
  visitDate: string;
  skinBiotype: string; // p. ej., "Piel grasa"
  fitzpatrickScale: number;
  skinConditions: string; // JSON string de string[] (p. ej., ["Acné", "Rosácea"])
  medicalDiagnosis?: string; // p. ej., "Dermatitis atópica"
  clinicalNotes: string;
  state: ConsultationState;
  steps?: ConsultationStep[];
  prescriptions?: Prescription[];
  allergies?: string;
  medicalConditions?: string;
}
