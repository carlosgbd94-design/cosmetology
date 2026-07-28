// Función unificada para interpretar arreglos JSON o texto separado por comas
export function parseStringList(input: any): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        return parsed.map(item => String(item).trim()).filter(Boolean);
      }
    } catch (e) {}
    return input.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// Definición de capas estándar de aplicación cosmetológica (Layering)
export const LAYERING_CATEGORIES: { name: string; category: string; order: number; icon: string }[] = [
  { name: 'Limpieza / Higiene', category: 'Limpieza', order: 1, icon: '🧼' },
  { name: 'Tonificación / Loción', category: 'Tonificación', order: 2, icon: '💦' },
  { name: 'Contorno de Ojos', category: 'Contorno de Ojos', order: 3, icon: '👁️' },
  { name: 'Suero / Activo Concentrado', category: 'Suero / Activo', order: 4, icon: '🧪' },
  { name: 'Crema / Emulsión / Hidratante', category: 'Crema de Día', order: 5, icon: '🧴' },
  { name: 'Protección Solar', category: 'Protección Solar', order: 6, icon: '☀️' },
  { name: 'Mascarilla Semanal', category: 'Mascarilla', order: 7, icon: '🎭' },
  { name: 'Exfoliación Semanal', category: 'Exfoliación', order: 8, icon: '✨' },
];

export function getLayerOrder(stepName: string): number {
  const norm = stepName.toLowerCase();
  if (norm.includes('limpia') || norm.includes('higiene') || norm.includes('shampoo') || norm.includes('gel limpiador')) return 1;
  if (norm.includes('tónic') || norm.includes('tonic') || norm.includes('loción') || norm.includes('locion') || norm.includes('armonizador')) return 2;
  if (norm.includes('ojos') || norm.includes('ocular') || norm.includes('contorno')) return 3;
  if (norm.includes('suero') || norm.includes('serum') || norm.includes('activo') || norm.includes('ampolleta') || norm.includes('concentrado')) return 4;
  if (norm.includes('crema') || norm.includes('emulsión') || norm.includes('emulsion') || norm.includes('hidratante') || norm.includes('humectante') || norm.includes('noche')) return 5;
  if (norm.includes('solar') || norm.includes('pantalla') || norm.includes('bloqueador') || norm.includes('spf') || norm.includes('fotoprotec')) return 6;
  if (norm.includes('mascarilla') || norm.includes('mask')) return 7;
  if (norm.includes('exfolia') || norm.includes('peeling') || norm.includes('scrub')) return 8;
  return 9;
}

export interface ActiveConflictAlert {
  severity: 'warning' | 'danger' | 'info';
  title: string;
  message: string;
  activesInvolved: string[];
}

// Analizador en tiempo real de incompatibilidades de activos en el protocolo
export function analyzePrescriptionSafety(prescriptions: Prescription[]): ActiveConflictAlert[] {
  const alerts: ActiveConflictAlert[] = [];

  const amItems = prescriptions.filter(p => p.timeOfDay === 'Dia' || p.timeOfDay === 'Dia y Noche');
  const pmItems = prescriptions.filter(p => p.timeOfDay === 'Noche' || p.timeOfDay === 'Dia y Noche');

  const getActives = (items: Prescription[]) => {
    return items.map(p => (p.customActiveIngredients || p.productDetails?.activeIngredients || '').toLowerCase()).join(' ');
  };

  const amActives = getActives(amItems);
  const pmActives = getActives(pmItems);

  // 1. Fotosensibilidad en AM
  if (amActives.includes('retinol') || amActives.includes('tretinoina') || amActives.includes('adapaleno') || amActives.includes('ácido glicólico') || amActives.includes('glicolico')) {
    alerts.push({
      severity: 'danger',
      title: 'Fotosensibilidad en Rutina de Día (AM)',
      message: 'Se detectaron retinoides o hidroxiácidos en la rutina de día. Estos activos aumentan la fotosensibilidad cutánea. Se recomienda reprogramarlos para la rutina de noche (PM) y aplicar fotoprotector solar estricto.',
      activesInvolved: ['Retinoides / AHA en AM']
    });
  }

  // 2. Conflicto Retinol + AHAs/BHAs en PM
  const hasRetinol = pmActives.includes('retinol') || pmActives.includes('retinoic') || pmActives.includes('retinal');
  const hasAcids = pmActives.includes('glicólico') || pmActives.includes('glicolico') || pmActives.includes('salicílico') || pmActives.includes('salicilico') || pmActives.includes('mandélico');

  if (hasRetinol && hasAcids) {
    alerts.push({
      severity: 'warning',
      title: 'Riesgo de Irritación: Retinol + Hidroxiácidos (AHA/BHA)',
      message: 'Combinar Retinol con Alfa o Beta hidroxiácidos en la misma aplicación puede comprometer la barrera cutánea y generar eritema. Se sugiere alternar noches (ej. Retinol noches pares, Ácidos noches impares).',
      activesInvolved: ['Retinol', 'AHA/BHA']
    });
  }

  // 3. Ausencia de Fotoprotección en AM
  const hasSunscreen = amItems.some(p => {
    const name = (p.stepName || '' ) + (p.customProductName || '') + (p.productDetails?.name || '');
    return getLayerOrder(name) === 6;
  });

  if (amItems.length > 0 && !hasSunscreen) {
    alerts.push({
      severity: 'info',
      title: 'Falta Fotoprotección Solar (AM)',
      message: 'La rutina de día no incluye un protector solar prescrito. La fotoprotección diaria es indispensable en cualquier tratamiento dermoestético.',
      activesInvolved: ['Protección Solar']
    });
  }

  return alerts;
}

// Generador de Rutina Domiciliaria Sugerida basada en el Biotipo y Condición
export function generateSuggestedHomeRoutine(biotype: string, conditionsStr: string, availableProducts: Product[]): Partial<Prescription>[] {
  const bio = (biotype || '').toLowerCase();
  const conditions = (conditionsStr || '').toLowerCase();

  const findProd = (keywords: string[]) => {
    return availableProducts.find(p => {
      const fullText = (p.name + ' ' + p.brandLine + ' ' + (typeof p.activeIngredients === 'string' ? p.activeIngredients : JSON.stringify(p.activeIngredients)) + ' ' + (typeof p.physiologicalActions === 'string' ? p.physiologicalActions : JSON.stringify(p.physiologicalActions))).toLowerCase();
      return keywords.some(kw => fullText.includes(kw));
    });
  };

  const routine: Partial<Prescription>[] = [];

  // 1. Limpiador
  const cleanserKeywords = bio.includes('grasa') || bio.includes('acne') ? ['limpiad', 'gel limpiador', 'shampoo', 'sebo'] : ['limpiad', 'leche', 'espuma', 'suave'];
  const cleanser = findProd(cleanserKeywords);
  routine.push({
    stepName: 'Limpieza / Higiene',
    timeOfDay: 'Dia y Noche',
    customProductName: cleanser ? cleanser.name : (bio.includes('grasa') ? 'Gel Limpiador Seborregulador' : 'Limpiador Suave Dermatológico'),
    customBrand: cleanser ? cleanser.brandLine : 'Línea Clínica',
    customActiveIngredients: cleanser ? (typeof cleanser.activeIngredients === 'string' ? cleanser.activeIngredients : JSON.stringify(cleanser.activeIngredients)) : (bio.includes('grasa') ? 'Ácido Salicílico, Árbol de Té' : 'Pantenol, Manzanilla'),
    dosageInstructions: 'Aplicar sobre rostro húmedo con masaje circular suave durante 60 segundos y enjuagar con agua templada.',
    applicationFrequency: 'Diario (Mañana y Noche)',
    productId: cleanser?.id,
    productDetails: cleanser
  });

  // 2. Tonificación
  const tonerKeywords = bio.includes('sensible') || bio.includes('rosácea') ? ['tónico', 'loción', 'descongestivo', 'calmante'] : ['tónico', 'loción', 'armonizador', 'astringente'];
  const toner = findProd(tonerKeywords);
  routine.push({
    stepName: 'Tonificación / Loción',
    timeOfDay: 'Dia y Noche',
    customProductName: toner ? toner.name : 'Loción Tonificante Armonizadora',
    customBrand: toner ? toner.brandLine : 'Línea Clínica',
    customActiveIngredients: toner ? (typeof toner.activeIngredients === 'string' ? toner.activeIngredients : JSON.stringify(toner.activeIngredients)) : 'Agua de Rosas, Niacinamida, Hamamelis',
    dosageInstructions: 'Brumizar a 20cm del rostro o aplicar con suave tecleo de yemas hasta su total absorción.',
    applicationFrequency: 'Diario (Mañana y Noche)',
    productId: toner?.id,
    productDetails: toner
  });

  // 3. Suero Concentrado
  const serumKeywords = bio.includes('anti-aging') || bio.includes('madura') ? ['suero', 'serum', 'hialurónico', 'péptidos'] : (conditions.includes('mancha') || conditions.includes('hipercrom') ? ['suero', 'serum', 'vitamina c', 'kojico', 'despigmentante'] : ['suero', 'serum', 'hialurónico', 'hidratante']);
  const serum = findProd(serumKeywords);
  routine.push({
    stepName: 'Suero / Activo Concentrado',
    timeOfDay: 'Dia',
    customProductName: serum ? serum.name : (bio.includes('anti-aging') ? 'Suero Reafirmante con Péptidos' : 'Suero Hidratante Concentrado Hialurónico'),
    customBrand: serum ? serum.brandLine : 'Línea Clínica',
    customActiveIngredients: serum ? (typeof serum.activeIngredients === 'string' ? serum.activeIngredients : JSON.stringify(serum.activeIngredients)) : 'Ácido Hialurónico Multinivel, Vitamina B5',
    dosageInstructions: 'Aplicar 3 a 4 gotas distribuidas en frente, mejillas y mentón.',
    applicationFrequency: 'Diario por la Mañana',
    productId: serum?.id,
    productDetails: serum
  });

  // 4. Crema / Emulsión
  const creamKeywords = bio.includes('alípica') || bio.includes('seca') ? ['crema rica', 'nutritiva', 'ceramid'] : ['emulsión', 'crema', 'gel', 'fluido'];
  const cream = findProd(creamKeywords);
  routine.push({
    stepName: 'Crema / Emulsión / Hidratante',
    timeOfDay: 'Noche',
    customProductName: cream ? cream.name : 'Crema Restructurante Nutritiva Noche',
    customBrand: cream ? cream.brandLine : 'Línea Clínica',
    customActiveIngredients: cream ? (typeof cream.activeIngredients === 'string' ? cream.activeIngredients : JSON.stringify(cream.activeIngredients)) : 'Ceramidas, Escualano, Coenzima Q10',
    dosageInstructions: 'Extender una pequeña cantidad en rostro y cuello con pases ascendentes.',
    applicationFrequency: 'Diario por la Noche',
    productId: cream?.id,
    productDetails: cream
  });

  // 5. Fotoprotector Solar
  const sunKeywords = ['solar', 'pantalla', 'bloqueador', 'spf', 'fotoprotec'];
  const sun = findProd(sunKeywords);
  routine.push({
    stepName: 'Protección Solar',
    timeOfDay: 'Dia',
    customProductName: sun ? sun.name : 'Fotoprotector Fluido Toque Seco SPF 50+',
    customBrand: sun ? sun.brandLine : 'Línea Clínica',
    customActiveIngredients: sun ? (typeof sun.activeIngredients === 'string' ? sun.activeIngredients : JSON.stringify(sun.activeIngredients)) : 'Filtros UVA/UVB Amplio Espectro, Óxido de Zinc',
    dosageInstructions: 'Aplicar generosamente 15 minutos antes de la exposición solar. Replicar cada 2 a 3 horas.',
    applicationFrequency: 'Diario por la Mañana y Reaplicación',
    productId: sun?.id,
    productDetails: sun
  });

  return routine;
}
