import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { Patient, Consultation } from './types';

// Paleta corporativa de Medicina Estética (Azul Slate Corporate)
const styles = StyleSheet.create({
  page: {
    paddingTop: 55,
    paddingBottom: 65,
    paddingHorizontal: 40,
    backgroundColor: '#FFFFFF',
    fontFamily: 'Helvetica',
  },
  header: {
    position: 'absolute',
    top: 15,
    left: 40,
    right: 40,
    borderBottomWidth: 1,
    borderBottomColor: '#1A365D',
    paddingBottom: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLogo: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#1A365D',
    letterSpacing: 0.5,
  },
  headerSub: {
    fontSize: 6.5,
    color: '#718096',
    textAlign: 'right',
  },
  footer: {
    position: 'absolute',
    bottom: 25,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: {
    fontSize: 6,
    color: '#A0AEC0',
    maxWidth: '80%',
  },
  footerPages: {
    fontSize: 7,
    color: '#718096',
  },
  title: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1A365D',
    marginTop: 20,
    marginBottom: 12,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  card: {
    marginBottom: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 3,
  },
  cardTitle: {
    fontSize: 8.5,
    fontWeight: 'bold',
    color: '#1A365D',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    paddingBottom: 2,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridCol: {
    width: '50%',
    marginBottom: 4,
  },
  label: {
    fontSize: 7,
    color: '#718096',
    fontWeight: 'bold',
  },
  value: {
    fontSize: 8.5,
    color: '#2D3748',
  },
  table: {
    width: '100%',
    marginTop: 5,
    borderWidth: 1,
    borderColor: '#CBD5E0',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#F7FAFC',
    borderBottomWidth: 1,
    borderBottomColor: '#CBD5E0',
    paddingVertical: 3,
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  tableCellHeader: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#1A365D',
  },
  tableCell: {
    fontSize: 7,
    color: '#2D3748',
  },
  colOrder: { width: '5%' },
  colPhase: { width: '12%' },
  colProduct: { width: '18%' },
  colActives: { width: '20%' },
  colActions: { width: '20%' },
  colDescription: { width: '25%' },
});

interface PDFProps {
  patient: Patient;
  consultation: Consultation;
  type: 'ficha' | 'receta';
}

export const ClinicalReportPDF: React.FC<PDFProps> = ({ patient, consultation, type }) => {
  let conditionsList: string[] = [];
  try {
    conditionsList = JSON.parse(consultation.skinConditions);
  } catch (e) {
    conditionsList = [];
  }

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        
        {/* Encabezado fijo en todas las páginas */}
        <View style={styles.header} fixed>
          <Text style={styles.headerLogo}>COSMEDIC PEELING CORPORATION</Text>
          <Text style={styles.headerSub}>
            Licencia Sanitaria No. 19-33-A | Servicio Profesional de Cosmetología y Cosmeatría
          </Text>
        </View>

        {/* Título de la consulta dermoestética */}
        <Text style={styles.title}>
          {type === 'ficha' ? 'Expediente Clínico y Prescripción de Cabina' : 'Receta de Cuidado y Apoyo Domiciliario'}
        </Text>

        {/* Ficha de Identificación del Paciente */}
        <View style={styles.card} wrap={false}>
          <Text style={styles.cardTitle}>Datos del Paciente</Text>
          <View style={styles.grid}>
            <View style={styles.gridCol}>
              <Text style={styles.label}>Nombre Completo:</Text>
              <Text style={styles.value}>{`${patient.firstNameEncrypted} ${patient.lastNameEncrypted}`}</Text>
            </View>
            <View style={styles.gridCol}>
              <Text style={styles.label}>Fecha de Emisión:</Text>
              <Text style={styles.value}>{new Date(consultation.visitDate).toLocaleDateString()}</Text>
            </View>
            <View style={styles.gridCol}>
              <Text style={styles.label}>Biotipo Cutáneo:</Text>
              <Text style={styles.value}>{consultation.skinBiotype}</Text>
            </View>
            <View style={styles.gridCol}>
              <Text style={styles.label}>Fototipo Fitzpatrick:</Text>
              <Text style={styles.value}>Clase {consultation.fitzpatrickScale}</Text>
            </View>
          </View>
        </View>

        {type === 'ficha' && (
          <>
            {/* Diagnóstico y Condiciones Clínicas de la Piel */}
            <View style={styles.card} wrap={false}>
              <Text style={styles.cardTitle}>Valoración Clínica de la Sesión</Text>
              <View style={styles.grid}>
                <View style={styles.gridCol}>
                  <Text style={styles.label}>Protocolo:</Text>
                  <Text style={styles.value}>{consultation.medicalDiagnosis || 'Ninguno de base'}</Text>
                </View>
                <View style={styles.gridCol}>
                  <Text style={styles.label}>Condiciones cutáneas activas:</Text>
                  <Text style={styles.value}>
                    {conditionsList.length > 0 ? conditionsList.join(', ') : 'Ninguna registrada'}
                  </Text>
                </View>
                <View style={styles.gridCol}>
                  <Text style={styles.label}>Alergias:</Text>
                  <Text style={styles.value}>{consultation.allergies || 'Ninguna registrada'}</Text>
                </View>
                <View style={styles.gridCol}>
                  <Text style={styles.label}>Condiciones Médicas:</Text>
                  <Text style={styles.value}>{consultation.medicalConditions || 'Ninguna registrada'}</Text>
                </View>
              </View>
              <View style={{ marginTop: 6 }}>
                <Text style={styles.label}>Observaciones Clínicas / SOAP / Zonas Afectadas:</Text>
                <Text style={styles.value}>{consultation.clinicalNotes}</Text>
              </View>
            </View>

            {/* Tabla del Protocolo en Cabina (Mapeo de la Ficha Técnica Dermoestética) */}
            <View style={styles.card} wrap={false}>
              <Text style={styles.cardTitle}>Secuencia Detallada del Protocolo en Cabina</Text>
              <View style={styles.table}>
                
                {/* Cabecera de la tabla */}
                <View style={styles.tableHeader}>
                  <View style={styles.colOrder}><Text style={styles.tableCellHeader}>No.</Text></View>
                  <View style={styles.colPhase}><Text style={styles.tableCellHeader}>Protocolo</Text></View>
                  <View style={styles.colProduct}><Text style={styles.tableCellHeader}>Producto / Marca</Text></View>
                  <View style={styles.colActives}><Text style={styles.tableCellHeader}>Activos</Text></View>
                  <View style={styles.colActions}><Text style={styles.tableCellHeader}>Acción / Efecto</Text></View>
                  <View style={styles.colDescription}><Text style={styles.tableCellHeader}>Descripción / Aparatología</Text></View>
                </View>

                {/* Renderizado de Pasos */}
                {consultation.steps && consultation.steps.length > 0 ? (
                  consultation.steps.map((step) => {
                    const productName = step.productDetails?.name || step.customProductName || 'Insumo de Cabina';
                    const brand = step.productDetails?.brandLine || step.customBrand || 'N/A';
                    
                    // Procesar ingredientes activos
                    let actives = 'N/A';
                    if (step.productDetails) {
                      try {
                        actives = JSON.parse(step.productDetails.activeIngredients).join(', ');
                      } catch (e) {
                        actives = step.productDetails.activeIngredients;
                      }
                    } else if (step.customActiveIngredients) {
                      actives = step.customActiveIngredients;
                    }

                    // Procesar acciones
                    let actions = 'N/A';
                    if (step.productDetails) {
                      try {
                        actions = JSON.parse(step.productDetails.physiologicalActions).join(', ');
                      } catch (e) {
                        actions = step.productDetails.physiologicalActions;
                      }
                    } else if (step.customActions) {
                      actions = step.customActions;
                    }

                    // Procesar aparatología
                    let aparatology = '';
                    if (step.aparatologySettings) {
                      try {
                        const parsedAp = JSON.parse(step.aparatologySettings);
                        aparatology = Array.isArray(parsedAp) ? parsedAp.join(', ') : step.aparatologySettings;
                      } catch (e) {
                        aparatology = step.aparatologySettings;
                      }
                    }
                    const descAndAp = step.applicationDescription 
                      ? (aparatology ? `${step.applicationDescription} (Aparatología: ${aparatology})` : step.applicationDescription)
                      : (aparatology ? `Aparatología: ${aparatology}` : 'Aplicar según protocolo base.');

                    return (
                      <View key={step.id} style={styles.tableRow} wrap={false}>
                        <View style={styles.colOrder}>
                          <Text style={styles.tableCell}>{step.stepOrder}</Text>
                        </View>
                        <View style={styles.colPhase}>
                          <Text style={styles.tableCell}>{step.stepName}</Text>
                        </View>
                        <View style={styles.colProduct}>
                          <Text style={styles.tableCell}>{`${productName} (${brand})`}</Text>
                        </View>
                        <View style={styles.colActives}>
                          <Text style={styles.tableCell}>{actives}</Text>
                        </View>
                        <View style={styles.colActions}>
                          <Text style={styles.tableCell}>{actions}</Text>
                        </View>
                        <View style={styles.colDescription}>
                          <Text style={styles.tableCell}>{descAndAp}</Text>
                        </View>
                      </View>
                    );
                  })
                ) : (
                  <View style={styles.tableRow}>
                    <Text style={[styles.tableCell, { padding: 4 }]}>No se registraron pasos de protocolo en esta sesión.</Text>
                  </View>
                )}
              </View>
            </View>
          </>
        )}

        {/* Sección de Recetas de Apoyo en Casa */}
        <View style={styles.card} wrap={false}>
          <Text style={styles.cardTitle}>Receta de Apoyo Domiciliario</Text>
          {consultation.prescriptions && consultation.prescriptions.length > 0 ? (
            consultation.prescriptions.map((pres, idx) => (
              <View key={pres.id} style={{ marginBottom: 6, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: '#F7FAFC' }} wrap={false}>
                <Text style={{ fontSize: 8.5, fontWeight: 'bold', color: '#1A365D' }}>
                  {`${idx + 1}. ${pres.productDetails?.name || 'Producto Sugerido'} (${pres.productDetails?.brandLine || 'N/A'}) - Aplicación: ${pres.timeOfDay}`}
                </Text>
                <Text style={styles.value}>
                  <Text style={{ fontWeight: 'bold' }}>Frecuencia: </Text>{pres.applicationFrequency} | <Text style={{ fontWeight: 'bold' }}>Instrucciones: </Text>{pres.dosageInstructions}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.value}>No se prescribieron productos para cuidado en el hogar en esta sesión.</Text>
          )}
        </View>

        {/* Pie de página corporativo fijo */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            Aviso Legal: El contenido de este reporte clínico es confidencial, de uso profesional exclusivo y está protegido bajo las normativas vigentes de expedientes clínicos dermoestéticos.
          </Text>
          <Text style={styles.footerPages} render={({ pageNumber, totalPages }) => (
            `Página ${pageNumber} de ${totalPages}`
          )} />
        </View>

      </Page>
    </Document>
  );
};
