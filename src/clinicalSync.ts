import {
  db,
  executeQuery,
  getTableName,
  parseTimestamp,
  pushPatientRemote,
  pushAnamnesisRemote,
  pushConsultationRemote,
  newId
} from './db';
import { decryptData } from './crypto';
import type { Patient, Anamnesis, Consultation, ConsultationStep, Prescription } from './types';

// Sincronización bidireccional de los datos clínicos (pacientes, anamnesis, consultas con sus pasos y
// prescripciones): gana SIEMPRE la copia más reciente (por updatedAt / updated_at), en ambos sentidos.
//
// Antes, al iniciar la app, el servidor SOBRESCRIBÍA incondicionalmente la copia local y nada subía lo
// pendiente. Consecuencias reales: una consulta editada o enviada a la papelera sin conexión se
// revertía al volver a abrir la app (la copia vieja del servidor ganaba), y un paciente o consulta
// creados sin conexión nunca llegaban a Turso. Misma clase de fallo que el catálogo de productos.
//
// - Registro solo local, o local más nuevo -> se sube (consulta completa: fila + pasos + prescripciones).
// - Registro solo remoto, o remoto más nuevo -> se baja. En consultas, los pasos y prescripciones
//   locales se REEMPLAZAN por los remotos (así un paso quitado desde otro dispositivo no reaparece).
// - Un registro local sin fecha (anterior a esta versión) nunca se considera "más nuevo": manda el servidor.
export async function syncClinicalWithRemote(): Promise<void> {
  await syncPatients();
  await syncAnamnesis();
  await syncConsultations();
}

async function syncPatients() {
  const tbl = getTableName('patients');
  const res = await executeQuery(
    `SELECT id, first_name_encrypted, last_name_encrypted, date_of_birth, email_hashed, phone_encrypted, created_at, updated_at, deleted_at FROM ${tbl}`
  );
  const remoteRows: any[] = res.rows || [];
  const local = new Map<string, Patient>((await db.patients.toArray()).map(p => [p.id, p]));
  const remoteIds = new Set<string>();
  const toPush: Patient[] = [];

  for (const r of remoteRows) {
    remoteIds.add(r.id);
    const l = local.get(r.id);
    const rTs = parseTimestamp(r.updated_at);
    const lTs = parseTimestamp(l?.updatedAt);
    if (!l || rTs > lTs) {
      try {
        await db.patients.put({
          id: r.id,
          firstNameEncrypted: await decryptData(r.first_name_encrypted),
          lastNameEncrypted: await decryptData(r.last_name_encrypted),
          dateOfBirth: r.date_of_birth,
          emailHashed: r.email_hashed,
          phoneEncrypted: await decryptData(r.phone_encrypted),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          deletedAt: r.deleted_at || undefined
        });
      } catch (e) {
        console.warn(`No se pudo descifrar/guardar el paciente ${r.id}; se omite:`, e);
      }
    } else if (lTs > rTs) {
      toPush.push(l);
    }
  }
  for (const [id, l] of local) if (!remoteIds.has(id)) toPush.push(l);

  for (const p of toPush) await pushPatientRemote(p);
}

async function syncAnamnesis() {
  const tbl = getTableName('anamnesis');
  const res = await executeQuery(
    `SELECT id, patient_id, medical_diagnosis, surgical_history, allergies_cosmetics, current_medications, lifestyle_metrics, updated_at FROM ${tbl}`
  );
  const remoteRows: any[] = res.rows || [];
  const local = new Map<string, Anamnesis>((await db.anamnesis.toArray()).map(a => [a.id, a]));
  const remoteIds = new Set<string>();
  const toPush: Anamnesis[] = [];

  for (const r of remoteRows) {
    remoteIds.add(r.id);
    const l = local.get(r.id);
    const rTs = parseTimestamp(r.updated_at);
    const lTs = parseTimestamp(l?.updatedAt);
    if (!l || rTs > lTs) {
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
    } else if (lTs > rTs) {
      toPush.push(l);
    }
  }
  for (const [id, l] of local) if (!remoteIds.has(id)) toPush.push(l);

  for (const a of toPush) await pushAnamnesisRemote(a);
}

async function syncConsultations() {
  const tblC = getTableName('consultations');
  const tblS = getTableName('consultation_steps');
  const tblP = getTableName('prescriptions');

  const consRes = await executeQuery(
    `SELECT id, patient_id, provider_id, visit_date, skin_biotype, fitzpatrick_scale, skin_conditions, medical_diagnosis, clinical_notes, state, recommendations, allergies, medical_conditions, consent_accepted, before_image_url, after_image_url, signature_data, updated_at, deleted_at FROM ${tblC}`
  );
  const stepsRes = await executeQuery(
    `SELECT id, consultation_id, step_order, step_name, product_id, custom_product_name, custom_brand, custom_active_ingredients, custom_actions, application_description, aparatology_settings FROM ${tblS}`
  );
  const presRes = await executeQuery(
    `SELECT id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency, step_name, custom_product_name, custom_brand, custom_active_ingredients, custom_actions FROM ${tblP}`
  );

  const stepsByCons = new Map<string, ConsultationStep[]>();
  for (const r of stepsRes.rows || []) {
    const step: ConsultationStep = {
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
    };
    (stepsByCons.get(r.consultation_id) || stepsByCons.set(r.consultation_id, []).get(r.consultation_id)!).push(step);
  }
  const presByCons = new Map<string, Prescription[]>();
  for (const r of presRes.rows || []) {
    const pres: Prescription = {
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
    };
    (presByCons.get(r.consultation_id) || presByCons.set(r.consultation_id, []).get(r.consultation_id)!).push(pres);
  }

  const local = new Map<string, Consultation>((await db.consultations.toArray()).map(c => [c.id, c]));
  const remoteIds = new Set<string>();
  const toPush: Consultation[] = [];
  const toPull: any[] = [];
  const toReconcile: any[] = [];

  // Qué consulta es dueña de cada id de paso/prescripción en el servidor.
  const remoteStepOwner = new Map<string, string>();
  for (const [cid, list] of stepsByCons) for (const st of list) remoteStepOwner.set(st.id, cid);
  const remotePresOwner = new Map<string, string>();
  for (const [cid, list] of presByCons) for (const pr of list) remotePresOwner.set(pr.id, cid);

  for (const r of consRes.rows || []) {
    remoteIds.add(r.id);
    const l = local.get(r.id);
    const rTs = parseTimestamp(r.updated_at);
    const lTs = parseTimestamp(l?.updatedAt);
    if (!l || rTs > lTs) toPull.push(r);
    else if (lTs > rTs) toPush.push(l);
    else toReconcile.push(r);
  }
  for (const [id, l] of local) if (!remoteIds.has(id)) toPush.push(l);

  // 1) Subidas primero. Un paso/prescripción local cuyo id ya pertenece a OTRA consulta en el servidor
  // (la versión anterior permitía que una consulta nueva "robara" las filas de otra al reutilizar ids)
  // hacía fallar la subida con clave duplicada, para siempre. Se le asigna un id nuevo.
  for (const c of toPush) {
    try {
      const steps = await db.consultation_steps.where('consultationId').equals(c.id).toArray();
      const pres = await db.prescriptions.where('consultationId').equals(c.id).toArray();
      const fixedSteps: ConsultationStep[] = [];
      for (const st of steps) {
        const owner = remoteStepOwner.get(st.id);
        if (owner && owner !== c.id) {
          const moved = { ...st, id: newId('STEP') };
          await db.consultation_steps.delete(st.id);
          await db.consultation_steps.put(moved);
          fixedSteps.push(moved);
        } else fixedSteps.push(st);
      }
      const fixedPres: Prescription[] = [];
      for (const pr of pres) {
        const owner = remotePresOwner.get(pr.id);
        if (owner && owner !== c.id) {
          const moved = { ...pr, id: newId('PRES') };
          await db.prescriptions.delete(pr.id);
          await db.prescriptions.put(moved);
          fixedPres.push(moved);
        } else fixedPres.push(pr);
      }
      await pushConsultationRemote(c, fixedSteps, fixedPres);
    } catch (e) {
      console.warn(`No se pudo subir la consulta ${c.id} a Turso; se reintentará en la próxima sincronización:`, e);
    }
  }

  // 2) Bajadas: la copia remota es más nueva (o no existe local): reemplaza fila, pasos y prescripciones.
  const replaceLocalFromRemote = async (r: any) => {
    const consultation: Consultation = {
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
      updatedAt: r.updated_at || undefined,
      deletedAt: r.deleted_at || undefined
    };
    await db.transaction('rw', [db.consultations, db.consultation_steps, db.prescriptions], async () => {
      await db.consultations.put(consultation);
      await db.consultation_steps.where('consultationId').equals(r.id).delete();
      for (const st of stepsByCons.get(r.id) || []) await db.consultation_steps.put(st);
      await db.prescriptions.where('consultationId').equals(r.id).delete();
      for (const pr of presByCons.get(r.id) || []) await db.prescriptions.put(pr);
    });
  };
  for (const r of toPull) await replaceLocalFromRemote(r);

  // 3) Misma fecha en ambos lados pero pasos/prescripciones distintos (p. ej. filas que otra consulta
  // "robó" localmente): el servidor manda y se restauran.
  const sameIds = (a: { id: string }[], b: { id: string }[]) =>
    a.length === b.length && a.map(x => x.id).sort().join('|') === b.map(x => x.id).sort().join('|');
  for (const r of toReconcile) {
    const lSteps = await db.consultation_steps.where('consultationId').equals(r.id).toArray();
    const lPres = await db.prescriptions.where('consultationId').equals(r.id).toArray();
    if (!sameIds(lSteps, stepsByCons.get(r.id) || []) || !sameIds(lPres, presByCons.get(r.id) || [])) {
      await replaceLocalFromRemote(r);
    }
  }
}
