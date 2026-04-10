import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { appRoutes } from "../utils/routes";
import "./privacy-policy.css";

const sections = [
    {
        num: "1",
        title: "Information We Collect and Use",
        body: `We collect and process:\n\n• User-Provided Information (name, professional email, role) during onboarding.\n• Technical Manuals supplied by the Client or Vessel owner for secure integration into the Application's database.\n• Vessel Operational Metrics and Vessel Data (pressure, temperature, engine load, RPM, machinery hours, maintenance records, operational logs, etc.) received in real time from the Vessel's systems.\n\nAll Vessel Data remains the property of the Client / Vessel owner. The Client hereby grants, and shall procure that the Vessel owner grants, to the Company a non-exclusive, worldwide, perpetual, irrevocable, royalty-free licence to access, use, store, process, analyse, reproduce and derive insights from the Vessel Data for the purposes of providing the Services, AI analysis, service improvement, product development, analytics and internal business purposes.\n\nAll rights in any analyses, reports, models, algorithms, aggregated datasets, insights or other outputs created by the Company from the Vessel Data vest exclusively and irrevocably in the Company.`,
    },
    {
        num: "2",
        title: "Artificial Intelligence and Third-Party Subprocessors",
        body: `The Application uses third-party AI models (e.g. OpenAI, Google Gemini, Anthropic or equivalent) solely to generate context-aware technical responses. User queries, relevant sections of technical manuals and Vessel Data are sent to these subprocessors under strict data-processing agreements that prohibit use of the data for training their general models.\n\nData is processed only for the specific request and is deleted after processing.`,
    },
    {
        num: "3",
        title: "Automatically Collected Information",
        body: `We may automatically collect device type, unique device ID, IP address, operating system, browser type and app usage statistics.`,
    },
    {
        num: "4",
        title: "Data Security",
        body: `All data is encrypted in transit (HTTPS/TLS). Access is restricted to authorised personnel on a need-to-know basis. However, the Company shall have no liability for any cyber security incident, unauthorised access, malware or breach affecting the Vessel's systems or the Application except to the extent caused solely by the Company's gross negligence or wilful default.`,
    },
    {
        num: "5",
        title: "Advisory Nature – No Operational Responsibility",
        body: `The Application and all AI-generated insights are advisory and informational only. The Company does not assume and shall not be deemed to assume any control, command or operational responsibility in respect of the Vessel, its systems or its Crew.\n\nAll decisions relating to operation, navigation, maintenance and safety of the Vessel remain at all times the sole responsibility of the Client, the Vessel owner and the Crew. The Company shall have no liability whatsoever for any act, omission or decision taken by the Client, Vessel owner or Crew whether or not based on or in reliance upon any output from the Application.`,
    },
    {
        num: "6",
        title: 'No Warranty – "As Is"',
        body: `The Application is provided "as is" and "as available" without any warranty of fitness for purpose, accuracy, completeness or uninterrupted operation. The Company does not warrant that the AI analysis or Vessel Data processing will be error-free or suitable for operational or safety-critical decisions.\n\nUsers must always cross-check against primary gauges and manufacturer documentation.`,
    },
    {
        num: "7",
        title: "Limitation of Liability",
        body: `To the maximum extent permitted by law, the Company's liability arising under or in connection with the Application (whether in contract, tort including negligence, or otherwise) shall not exceed the lower of (i) the total aggregate fees paid by the Client under the Service Agreement or (ii) €1,000,000.\n\nThe Company shall in no event be liable for any indirect, consequential or special loss including loss of profit, loss of data, loss of use, or any loss arising from failure of onboard systems, internet connectivity, data inaccuracy or any decision based on Application outputs.\n\nThis clause survives termination.`,
    },
    {
        num: "8",
        title: "Intellectual Property",
        body: `All rights in the Application, its software, algorithms, AI models, interfaces, reports and outputs remain exclusively with the Company and its licensors. The Client is granted only a non-exclusive, non-transferable, revocable licence during the term of the Service Agreement solely for use on the Vessel.`,
    },
    {
        num: "9",
        title: "Account Deletion and Data Requests",
        body: `Users cannot self-delete accounts. Deletion of personal data may be requested in writing to info@trident-virtual.com. All personal data will be deleted within a reasonable period subject to legal retention obligations and the perpetual licence granted in respect of Vessel Data.`,
    },
    {
        num: "10",
        title: "Governing Law and Dispute Resolution",
        body: `These App Terms and any dispute arising out of or in connection with the Application shall be governed by the laws of England and Wales and shall be subject to the arbitration provisions set out in clause 12.7 of the Service Agreement (London arbitration).`,
    },
    {
        num: "11",
        title: "Survival Clauses",
        body: `Clauses 1 (Vessel Data licence), 5 (Advisory Nature), 6 (No Warranty), 7 (Limitation of Liability), 8 (IP) and 10 (Governing Law) shall survive any termination or expiry.`,
    },
    {
        num: "12",
        title: "Entire Agreement",
        body: `These App Terms together with the Service Agreement constitute the entire agreement in respect of the Application and supersede any prior statements. No variation shall be effective unless in writing signed by the Company.`,
    },
];

export function PrivacyPolicyPage() {
    const navigate = useNavigate();
    const { isAuthenticated } = useAuth();

    return (
        <div className="pp-layout">
            <div className="pp-container">
                {/* Header */}
                <div className="pp-header">
                    <button
                        className="pp-back-btn"
                        onClick={() => navigate(isAuthenticated ? appRoutes.chats : appRoutes.login)}
                        aria-label="Back"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                    <span className="pp-header-title">Privacy Policy & Terms</span>
                </div>

                {/* Title block */}
                <div className="pp-title-block">
                    <h1 className="pp-main-title">Privacy Policy<br />& Terms of Use</h1>
                    <p className="pp-subtitle">Trident Intelligence Platform · Version 1.0 · March 2026</p>
                    <hr className="pp-divider" />
                    <p className="pp-preamble">
                        This Privacy Policy and Terms of Use ("App Terms") governs access to and use of the Trident
                        Intelligence Platform mobile application provided by Trident Virtual ("the Company"). The Application
                        is an integral part of the remote engineering and vessel management services supplied under the
                        Trident Virtual Service Agreement. By accessing or using the Application, you agree to be bound by
                        these App Terms.
                    </p>
                </div>

                {/* Sections */}
                {sections.map((sec) => (
                    <div key={sec.num} className="pp-section">
                        <div className="pp-section-header">
                            <span className="pp-num-badge">{sec.num}</span>
                            <h2 className="pp-section-title">{sec.title}</h2>
                        </div>
                        <div className="pp-body">
                            {sec.body.split("\n\n").map((para, i) => (
                                <p key={i} className="pp-para">{para}</p>
                            ))}
                        </div>
                    </div>
                ))}

                {/* Contact */}
                <div className="pp-contact-block">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="20" height="16" x="2" y="4" rx="2" />
                        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                    </svg>
                    <div>
                        <div className="pp-contact-label">Privacy & data queries</div>
                        <a href="mailto:info@trident-virtual.com" className="pp-contact-email">
                            info@trident-virtual.com
                        </a>
                    </div>
                </div>

                {/* Footer */}
                <p className="pp-footer-note">
                    By using the Application you confirm that you have read, understood and agree to these App Terms and the Service Agreement.
                </p>
            </div>
        </div>
    );
}
