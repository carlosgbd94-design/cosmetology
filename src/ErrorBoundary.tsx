import React, { Component, ErrorInfo, ReactNode } from 'react';
import { reportReactError } from './errorHandler';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in ErrorBoundary:', error, errorInfo);
    // Send to Discord
    reportReactError(error, errorInfo.componentStack || 'No stack provided');
  }

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#FAF9F6] dark:bg-[#0A0A0D] p-6 font-sans">
          <div className="max-w-md w-full bg-white dark:bg-luxe-900 rounded-3xl shadow-2xl p-8 border border-slate-100 dark:border-luxe-800 text-center animate-fade-in-up">
            <div className="w-20 h-20 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-10 h-10 text-red-500" />
            </div>
            <h1 className="text-2xl font-bold font-sora text-slate-800 dark:text-white mb-3">
              Oops, algo salió mal
            </h1>
            <p className="text-slate-500 dark:text-luxe-300 mb-8 leading-relaxed">
              La aplicación encontró un problema inesperado. No te preocupes, el error ha sido enviado automáticamente al desarrollador para ser corregido.
            </p>
            <button
              onClick={this.handleReload}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-luxe-500 to-luxe-600 hover:from-luxe-400 hover:to-luxe-500 text-white py-4 px-6 rounded-2xl font-semibold transition-all transform hover:scale-[1.02] active:scale-95"
            >
              <RefreshCw className="w-5 h-5" />
              Recargar Aplicación
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
