import React from 'react';
import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';
import { Patient, Consultation } from './types';
import { getLayerOrder, parseStringList } from './cosmetologyLogic';

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
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  tableCellHeader: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#1A365D',
    paddingRight: 4,
  },
  tableCell: {
    fontSize: 7,
    color: '#2D3748',
    lineHeight: 1.3,
    paddingRight: 4,
  },
  colOrder: { width: '5%' },
  colPhase: { width: '12%' },
  colProduct: { width: '18%' },
  colActives: { width: '20%' },
  colActions: { width: '20%' },
  colDescription: { width: '25%' },
  signatureBox: {
    marginTop: 6,
    alignItems: 'center',
    width: '45%',
  },
  signatureImg: {
    width: 160,
    height: 60,
    objectFit: 'contain',
  },
  signatureLine: {
    borderTopWidth: 1,
    borderTopColor: '#2D3748',
    width: 160,
    marginTop: 2,
  },
  signatureCaption: {
    fontSize: 6.5,
    color: '#718096',
    marginTop: 3,
    textAlign: 'center',
  },
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
          <Text style={styles.headerLogo}></Text>
          <Text style={styles.headerSub}>
            Servicio Profesional de Cosmetología y Cosmeatría Dermoestética
          </Text>
        </View>

        {/* Título de la consulta dermoestética */}
        <Text style={styles.title}>
          {type === 'ficha' ? 'Expediente Clínico y Prescripción de Cabina' : 'Receta de Cuidado y Apoyo Domiciliario'}
        </Text>

        {/* Ficha de Identificación del Paciente */}
        <View style={styles.card} wrap={true}>
          <Text style={styles.cardTitle}>Datos del Paciente</Text>
          <View style={{ flexDirection: 'column' }}>
            <View style={{ flexDirection: 'row', marginBottom: 6 }}>
              <View style={{ width: '50%', paddingRight: 10 }}>
                <Text style={styles.label}>Nombre Completo:</Text>
                <Text style={styles.value}>{`${patient.firstNameEncrypted} ${patient.lastNameEncrypted}`}</Text>
              </View>
              <View style={{ width: '50%', paddingRight: 10 }}>
                <Text style={styles.label}>Fecha de Emisión:</Text>
                <Text style={styles.value}>{new Date(consultation.visitDate).toLocaleDateString()}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row' }}>
              <View style={{ width: '50%', paddingRight: 10 }}>
                <Text style={styles.label}>Biotipo Cutáneo:</Text>
                <Text style={styles.value}>{consultation.skinBiotype}</Text>
              </View>
              <View style={{ width: '50%', paddingRight: 10 }}>
                <Text style={styles.label}>Fototipo Fitzpatrick:</Text>
                <Text style={styles.value}>Clase {consultation.fitzpatrickScale}</Text>
              </View>
            </View>
          </View>
        </View>

        {type === 'ficha' && (
          <>
            {/* Diagnóstico y Condiciones Clínicas de la Piel */}
            <View style={styles.card} wrap={true}>
              <Text style={styles.cardTitle}>Valoración Clínicas de la Sesión</Text>
              <View style={{ flexDirection: 'column' }}>
                <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                  <View style={{ width: '50%', paddingRight: 10 }}>
                    <Text style={styles.label}>Protocolo:</Text>
                    <Text style={styles.value}>{consultation.medicalDiagnosis || 'Ninguno de base'}</Text>
                  </View>
                  <View style={{ width: '50%', paddingRight: 10 }}>
                    <Text style={styles.label}>Condiciones cutáneas activas:</Text>
                    <Text style={styles.value}>
                      {conditionsList.length > 0 ? conditionsList.join(', ') : 'Ninguna registrada'}
                    </Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row' }}>
                  <View style={{ width: '50%', paddingRight: 10 }}>
                    <Text style={styles.label}>Alergias:</Text>
                    <Text style={styles.value}>{consultation.allergies || 'Ninguna registrada'}</Text>
                  </View>
                  <View style={{ width: '50%', paddingRight: 10 }}>
                    <Text style={styles.label}>Condiciones Médicas/Procedimientos Qx:</Text>
                    <Text style={styles.value}>{consultation.medicalConditions || 'Ninguna registrada'}</Text>
                  </View>
                </View>
              </View>
              <View style={{ marginTop: 8 }}>
                <Text style={styles.label}>Observaciones Clínicas / SOAP / Zonas Afectadas:</Text>
                <Text style={styles.value}>{consultation.clinicalNotes}</Text>
              </View>
              {consultation.recommendations && (
                <View style={{ marginTop: 8 }}>
                  <Text style={styles.label}>Recomendaciones y Sugerencias de Apoyo:</Text>
                  <Text style={styles.value}>{consultation.recommendations}</Text>
                </View>
              )}
            </View>

            {/* Tabla del Protocolo en Cabina (Mapeo de la Ficha Técnica Dermoestética) */}
            <View style={styles.card} wrap={true}>
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
                  [...consultation.steps]
                    .sort((a, b) => a.stepOrder - b.stepOrder)
                    .map((step, idx) => {
                      const productName = step.productDetails?.name || step.customProductName || 'Insumo de Cabina';
                      const brand = step.productDetails?.brandLine || step.customBrand || 'N/A';
                      
                      // Procesar ingredientes activos y acciones con parser unificado
                      const activeList = parseStringList(step.productDetails?.activeIngredients || step.customActiveIngredients);
                      const actionList = parseStringList(step.productDetails?.physiologicalActions || step.customActions);

                      const pairs: { active: string; action: string }[] = [];
                      if (activeList.length === 0 && actionList.length === 0) {
                        pairs.push({ active: 'N/A', action: 'N/A' });
                      } else if (activeList.length > 0) {
                        activeList.forEach((act, i) => {
                          let actAction = 'N/A';
                          if (i < actionList.length) {
                            actAction = actionList[i];
                          } else if (actionList.length === 1) {
                            actAction = actionList[0];
                          } else if (actionList.length > 0) {
                            actAction = actionList[i % actionList.length];
                          }
                          pairs.push({ active: act, action: actAction });
                        });
                      } else {
                        actionList.forEach(act => {
                          pairs.push({ active: 'N/A', action: act });
                        });
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

                      // Reemplazar "sin producto" con la aparatología seleccionada si aplica
                      let productDisplay = `${productName} (${brand})`;
                      if (step.stepName?.toLowerCase().includes('aparatolog') || productName.toLowerCase().includes('sin producto') || productName.toLowerCase().includes('insumo de cabina')) {
                        if (aparatology && aparatology !== 'N/A') {
                          productDisplay = `Aparatología: ${aparatology}`;
                        }
                      }

                      return (
                        <View key={step.id} style={styles.tableRow} wrap={false}>
                          <View style={styles.colOrder}>
                            <Text style={styles.tableCell}>{idx + 1}</Text>
                          </View>
                          <View style={styles.colPhase}>
                            <Text style={styles.tableCell}>{step.stepName}</Text>
                          </View>
                          <View style={styles.colProduct}>
                            <Text style={styles.tableCell}>{productDisplay}</Text>
                          </View>
                          <View style={{ width: '40%', flexDirection: 'column' }}>
                            {pairs.map((pair, pIdx) => (
                              <View key={pIdx} style={{ flexDirection: 'row', borderBottomWidth: pIdx < pairs.length - 1 ? 0.5 : 0, borderBottomColor: '#E2E8F0', paddingVertical: 2 }}>
                                <View style={{ width: '50%', paddingRight: 4 }}>
                                  <Text style={styles.tableCell}>{pair.active}</Text>
                                </View>
                                <View style={{ width: '50%', paddingRight: 4 }}>
                                  <Text style={styles.tableCell}>{pair.action}</Text>
                                </View>
                              </View>
                            ))}
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
        <View style={styles.card} wrap={true}>
          <Text style={styles.cardTitle}>Protocolo de Apoyo Domiciliario y Guía para el Paciente</Text>
          {consultation.prescriptions && consultation.prescriptions.length > 0 ? (
            (() => {
              const allPres = [...consultation.prescriptions].sort((a, b) => {
                const orderA = getLayerOrder(a.stepName || a.customProductName || '');
                const orderB = getLayerOrder(b.stepName || b.customProductName || '');
                return orderA - orderB;
              });

              const amList = allPres.filter(p => p.timeOfDay === 'Dia' || p.timeOfDay === 'Dia y Noche');
              const pmList = allPres.filter(p => p.timeOfDay === 'Noche' || p.timeOfDay === 'Dia y Noche');

              const renderPresItem = (pres: typeof allPres[0], stepIdx: number) => {
                const prodName = pres.customProductName || pres.productDetails?.name || 'Producto Prescrito';
                const brand = pres.customBrand || pres.productDetails?.brandLine || 'Línea Clínica';
                
                let actives = pres.customActiveIngredients || '';
                if (!actives && pres.productDetails?.activeIngredients) {
                  try {
                    const parsed = JSON.parse(pres.productDetails.activeIngredients);
                    actives = Array.isArray(parsed) ? parsed.join(', ') : pres.productDetails.activeIngredients;
                  } catch(e) {
                    actives = pres.productDetails.activeIngredients;
                  }
                }

                return (
                  <View key={pres.id} style={{ marginBottom: 6, paddingBottom: 4, borderBottomWidth: 0.5, borderBottomColor: '#E2E8F0' }} wrap={false}>
                    <Text style={{ fontSize: 8, fontWeight: 'bold', color: '#1A365D' }}>
                      {`Paso ${stepIdx}: [${pres.stepName || 'Fase'}] ${prodName}`}
                      <Text style={{ fontSize: 7, color: '#718096', fontWeight: 'normal' }}> ({brand})</Text>
                    </Text>
                    {actives ? (
                      <Text style={{ fontSize: 6.5, color: '#4A5568', marginTop: 1 }}>
                        <Text style={{ fontWeight: 'bold' }}>Activos Clave: </Text>{actives}
                      </Text>
                    ) : null}
                    <Text style={{ fontSize: 7, color: '#2D3748', marginTop: 1.5 }}>
                      <Text style={{ fontWeight: 'bold', color: '#B7791F' }}>Instrucciones / Dosis: </Text>{pres.dosageInstructions} ({pres.applicationFrequency})
                    </Text>
                  </View>
                );
              };

              return (
                <View>
                  {amList.length > 0 && (
                    <View style={{ marginBottom: 8 }}>
                      <Text style={{ fontSize: 8, fontWeight: 'bold', color: '#B7791F', marginBottom: 4, textTransform: 'uppercase' }}>
                        ☀️ Rutina de Día (AM) - Secuencia de Capas
                      </Text>
                      {amList.map((p, i) => renderPresItem(p, i + 1))}
                    </View>
                  )}

                  {pmList.length > 0 && (
                    <View style={{ marginTop: 4, marginBottom: 8 }}>
                      <Text style={{ fontSize: 8, fontWeight: 'bold', color: '#2C5282', marginBottom: 4, textTransform: 'uppercase' }}>
                        🌙 Rutina de Noche (PM) - Secuencia de Capas
                      </Text>
                      {pmList.map((p, i) => renderPresItem(p, i + 1))}
                    </View>
                  )}
                </View>
              );
            })()
          ) : (
            <Text style={styles.value}>No se prescribieron productos para cuidado en el hogar en esta sesión.</Text>
          )}
        </View>

        {/* Consentimiento Informado firmado (solo si la consulta se capturó en un dispositivo táctil) */}
        {consultation.signatureData && (
          <View style={styles.card} wrap={false}>
            <Text style={styles.cardTitle}>Consentimiento Informado — Firma del Paciente</Text>
            <Text style={{ fontSize: 7, color: '#4A5568', marginBottom: 6 }}>
              El paciente firmó digitalmente en el dispositivo del especialista, confirmando haber recibido la
              información sobre el tratamiento y otorgando su consentimiento para realizarlo.
            </Text>
            <View style={styles.signatureBox}>
              <Image style={styles.signatureImg} src={consultation.signatureData} />
              <View style={styles.signatureLine} />
              <Text style={styles.signatureCaption}>
                Firma del paciente — {new Date(consultation.visitDate).toLocaleDateString()}
              </Text>
            </View>
          </View>
        )}

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
