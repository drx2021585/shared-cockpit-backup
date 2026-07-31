using System.Reflection;
using System.Text.Json.Nodes;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using SharedCockpit.Bridge.Protocol;
using Xunit;

namespace SimulatorBridge.Tests;

public class BridgeServiceConfirmAfterWriteTests
{
    /// <summary>
    /// Algo mas que el espaciado entre escrituras al mismo trigger
    /// (BridgeService.TriggerWriteSpacingMs = 50 ms), para que el drenado que
    /// simula el pump encuentre el turno ya libre.
    /// </summary>
    private const int TriggerSpacingSettleMs = 60;

    [Fact]
    public void ConfirmAfterWrite_RetriesUntilObservedValueConverges()
    {
        var sim = new FakeSimConnectClient();
        var calculator = new FakeCalculatorCodeClient();
        var service = new BridgeService(
            sim,
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithConfirmAfterWriteControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1",
            ControlId: "gear.autobrake_sw",
            RawValue: JsonValue.Create(2d),
            Source: "test",
            Sequence: 1,
            Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Single(calculator.ExecutedCodes);

        // El sim todavía no llegó al valor pedido; al vencer el intervalo de
        // reintento debe volver a escribir.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 1d);
        Thread.Sleep(120);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");

        Assert.Equal(2, calculator.ExecutedCodes.Count);

        // Una vez que el sim confirma el valor objetivo, no deben emitirse más reintentos.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 2d);
        Thread.Sleep(120);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");

        Assert.Equal(2, calculator.ExecutedCodes.Count);
    }


    /// <summary>
    /// Los controles del iFly no aceptan un SET absoluto: cada escritura avanza UN
    /// paso y la dirección la decide el RPN del perfil. Si ese RPN tuviera los
    /// códigos de subir/bajar cruzados, cada reintento alejaría el control un paso
    /// más del destino. La convergencia tiene que cortarse apenas se detecta eso,
    /// en vez de gastar toda la ventana empujando para el lado equivocado.
    /// </summary>
    [Fact]
    public void ConfirmAfterWrite_AbortsAndReportsPolarity_WhenValueMovesAwayFromTarget()
    {
        var calculator = new FakeCalculatorCodeClient();
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithConfirmAfterWriteControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1",
            ControlId: "gear.autobrake_sw",
            RawValue: JsonValue.Create(5d),
            Source: "test",
            Sequence: 1,
            Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Single(calculator.ExecutedCodes);

        // Se acerca (4 -> distancia 1)...
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 4d);
        // ...y de pronto se ALEJA (2 -> distancia 3): polaridad invertida.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 2d);

        var polarityError = broadcasts.SingleOrDefault(b =>
            b["type"]?.GetValue<string>() == "bridge.error"
            && b["operation"]?.GetValue<string>() == "confirmAfterWrite");
        Assert.NotNull(polarityError);
        Assert.Contains("polaridad invertida", polarityError!["message"]?.GetValue<string>());

        // Y sobre todo: no se siguen mandando pasos en la dirección equivocada.
        Thread.Sleep(120);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");
        Assert.Single(calculator.ExecutedCodes);
    }


    /// <summary>
    /// Regresión del bug que rompió la primera sesión real de dos jugadores
    /// (2026-07-29): al conectar, el bridge del otro piloto emite el estado
    /// inicial de sus ~982 controles y la UI los reenvía TODOS como escrituras.
    /// Como los dos aviones arrancan en el mismo estado, casi todas pedían el
    /// valor que el control ya tenía -- pero se escribían igual y quedaban
    /// esperando una confirmación que nunca llegaba (el bridge solo emite
    /// lecturas cuando algo CAMBIA). Resultado: ~1100 escrituras encoladas a
    /// ~650 ms cada una tapando el canal de FSUIPC durante minutos, y 111
    /// "no convergió" en un solo segundo del log. El usuario lo vio como
    /// "solo algunos botones funcionan".
    /// </summary>
    [Fact]
    public void IncomingWrite_IsSkipped_WhenControlIsAlreadyAtThatValue()
    {
        var calculator = new FakeCalculatorCodeClient();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithConfirmAfterWriteControl());

        // El sim ya reportó que el control está en 2.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 2d);

        // El compañero pide exactamente 2: no hay nada que escribir.
        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(2d),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Empty(calculator.ExecutedCodes);

        // Y sin escritura tampoco puede quedar una confirmación pendiente que
        // luego reintente 9 veces y termine en un "no convergió" falso.
        Thread.Sleep(120);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");
        Assert.Empty(calculator.ExecutedCodes);

        // Un valor DISTINTO sí se escribe: el descarte no puede tragarse cambios reales.
        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(3d),
            Source: "peer", Sequence: 2, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Single(calculator.ExecutedCodes);
    }


    /// <summary>
    /// Un control que NO SE MUEVE y uno que se mueve pero llega tarde son fallos
    /// distintos y hay que poder distinguirlos en el log: el primero es la firma
    /// de una polaridad invertida empujando contra el tope, que es CIEGA para la
    /// deteccion de divergencia (esa necesita ver la distancia crecer, y sin
    /// lecturas no hay distancia). Antes los dos decian "no convergio".
    /// </summary>
    [Fact]
    public void ConfirmAfterWrite_ReportsDidNotMove_WhenNoReadingArrivedAtAll()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        SetMatchedProfile(service, MakeProfileWithConfirmAfterWriteControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(5d),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        // Ninguna lectura: el control jamas se movio. Se agota la ventana
        // (timeoutMs 400 en el perfil de prueba).
        Thread.Sleep(500);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");

        var err = broadcasts.LastOrDefault(b =>
            b["operation"]?.GetValue<string>() == "confirmAfterWrite");
        Assert.NotNull(err);
        Assert.Contains("NO SE MOVIÓ", err!["message"]?.GetValue<string>());
        Assert.Contains("polaridad invertida", err["message"]?.GetValue<string>());
    }

    [Fact]
    public void ConfirmAfterWrite_ReportsDidNotConverge_WhenItMovedButNeverArrived()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        SetMatchedProfile(service, MakeProfileWithConfirmAfterWriteControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(5d),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        // Se acerca (3, luego 4) pero nunca llega a 5.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 3d);
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 4d);
        Thread.Sleep(500);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");

        var err = broadcasts.LastOrDefault(b =>
            b["operation"]?.GetValue<string>() == "confirmAfterWrite");
        Assert.NotNull(err);
        Assert.Contains("no convergió", err!["message"]?.GetValue<string>());
        Assert.DoesNotContain("NO SE MOVIÓ", err["message"]?.GetValue<string>());
    }

    /// <summary>
    /// EL CAMBIO DE FONDO respecto de la 0.1.13: detectar la polaridad invertida ya
    /// no termina en un error. El bridge invierte el RPN del control, reintenta, y
    /// recuerda la corrección.
    ///
    /// Esto es lo que convierte los ~340 controles posicionales sin calibrar de
    /// "hay que medirlos uno por uno contra MSFS y editar los YAML a mano" a "se
    /// corrigen solos la primera vez que alguien los usa". El coste de un control
    /// mal calibrado pasa a ser un paso perdido, una vez en la vida del perfil.
    /// </summary>
    [Fact]
    public void ConfirmAfterWrite_InvertsPolarityAndRetries_WhenValueMovesAwayFromTarget()
    {
        var calculator = new FakeCalculatorCodeClient();
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithInvertiblePositionalControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1",
            ControlId: "gear.autobrake_sw",
            RawValue: JsonValue.Create(5d),
            Source: "test",
            Sequence: 1,
            Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        // En el RPN ya ejecutado, $value fue sustituido por el valor pedido (5).
        Assert.Single(calculator.ExecutedCodes);
        Assert.Contains("5 < if{ 2 ", calculator.ExecutedCodes[0]);

        // Se acerca (4 -> distancia 1) y de pronto se ALEJA (2 -> distancia 3).
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 4d);
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 2d);

        // En vez de rendirse, reescribe con la dirección intercambiada: el código 2,
        // que antes se disparaba al ir hacia arriba, ahora va hacia abajo.
        // Esa reescritura va al MISMO trigger que la original, así que desde el
        // reparto de turnos (ver BridgeService.TryReserveTriggerSlot) espera a que
        // pase un frame en vez de salir en el acto -- si saliera ya, el addon leería
        // una sola de las dos y la corrección se perdería. Se drena como hace el pump.
        Thread.Sleep(TriggerSpacingSettleMs);
        InvokePrivate(service, "DrainDeferredTriggerWrites");

        Assert.Equal(2, calculator.ExecutedCodes.Count);
        Assert.Contains("5 > if{ 2 ", calculator.ExecutedCodes[1]);
        Assert.Contains("5 < if{ 3 ", calculator.ExecutedCodes[1]);

        // Y no se reportó ningún error: el fallo se resolvió solo.
        Assert.DoesNotContain(
            broadcasts,
            b => b["operation"]?.GetValue<string>() == "confirmAfterWrite");

        // Al converger en la dirección corregida, se cierra sin más reintentos.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 5d);
        Thread.Sleep(150);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");
        Assert.Equal(2, calculator.ExecutedCodes.Count);
    }

    /// <summary>
    /// El punto ciego que la 0.1.13 solo sabía nombrar: un control con la polaridad
    /// cruzada que YA está contra su tope no se mueve, así que no llega ninguna
    /// lectura y la detección por divergencia (que necesita ver crecer la
    /// distancia) nunca se dispara. Acá también hay que probar a invertir.
    /// </summary>
    [Fact]
    public void ConfirmAfterWrite_InvertsPolarityAndRetries_WhenControlNeverMovesAtAll()
    {
        var calculator = new FakeCalculatorCodeClient();
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithInvertiblePositionalControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(5d),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Single(calculator.ExecutedCodes);

        // Ni una sola lectura en toda la ventana.
        Thread.Sleep(500);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");

        // Invirtió y reintentó en vez de reportar el fallo.
        Assert.Equal(2, calculator.ExecutedCodes.Count);
        Assert.Contains("5 > if{ 2 ", calculator.ExecutedCodes[1]);
        Assert.DoesNotContain(
            broadcasts,
            b => b["operation"]?.GetValue<string>() == "confirmAfterWrite");
    }

    /// <summary>
    /// La otra mitad de la seguridad: si tras invertir el control SIGUE alejándose,
    /// la polaridad no era la causa. La inversión se deshace para no dejar el
    /// control peor de como estaba, y recién ahí se reporta el error.
    ///
    /// Sin esto, cualquier fallo ajeno a la polaridad (sistema sin alimentación,
    /// L-Var inexistente en la variante) dejaría una inversión errónea PERSISTIDA,
    /// rompiendo un control que estaba bien declarado.
    /// </summary>
    [Fact]
    public void ConfirmAfterWrite_RevertsInversion_WhenItDivergesInBothDirections()
    {
        var calculator = new FakeCalculatorCodeClient();
        var broadcasts = new List<JsonObject>();
        var calibration = new PolarityCalibration();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator,
            polarityCalibration: calibration);

        SetMatchedProfile(service, MakeProfileWithInvertiblePositionalControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(5d),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        // Primera divergencia -> invierte.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 4d);
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 2d);
        Assert.True(calibration.IsInverted("ifly-737-max8", "gear.autobrake_sw"));

        // Segunda divergencia, ya invertido -> se descarta la polaridad como causa.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 4d);
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 1d);

        Assert.False(calibration.IsInverted("ifly-737-max8", "gear.autobrake_sw"));

        var err = broadcasts.LastOrDefault(b =>
            b["operation"]?.GetValue<string>() == "confirmAfterWrite");
        Assert.NotNull(err);
        Assert.Contains("polaridad invertida", err!["message"]?.GetValue<string>());
    }

    /// <summary>
    /// Un control ya calibrado (de una sesión anterior, vía el JSON persistido)
    /// tiene que escribirse invertido DESDE LA PRIMERA escritura, sin volver a
    /// pagar el paso perdido del descubrimiento.
    /// </summary>
    [Fact]
    public void Write_UsesInvertedRpnFromTheStart_WhenCalibrationWasAlreadyLearned()
    {
        var calculator = new FakeCalculatorCodeClient();
        var calibration = new PolarityCalibration();
        calibration.MarkInverted("ifly-737-max8", "gear.autobrake_sw");

        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator,
            polarityCalibration: calibration);

        SetMatchedProfile(service, MakeProfileWithInvertiblePositionalControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(5d),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Single(calculator.ExecutedCodes);
        Assert.Contains("5 > if{ 2 ", calculator.ExecutedCodes[0]);
    }

    /// <summary>
    /// Las L-Vars del iFly se ANIMAN: NOTAS-SDK.md documenta 14.75 leído en tránsito
    /// entre 20 y 10. Un control correcto puede entonces sobrepasar el destino y
    /// alejarse respecto de la lectura ANTERIOR sin que haya nada mal.
    ///
    /// Ese sobrepaso no puede leerse como polaridad invertida: con la autocorrección
    /// puesta, hacerlo INVIERTE y PERSISTE un control que estaba bien, y a partir de
    /// ahí se mueve al revés para siempre. Por eso la divergencia se juzga contra la
    /// distancia de PARTIDA, no contra la lectura previa.
    /// </summary>
    [Fact]
    public void ConfirmAfterWrite_DoesNotInvertPolarity_WhenAnAnimatedLVarOvershootsTheTarget()
    {
        var calculator = new FakeCalculatorCodeClient();
        var broadcasts = new List<JsonObject>();
        var calibration = new PolarityCalibration();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator,
            polarityCalibration: calibration);

        SetMatchedProfile(service, MakeProfileWithInvertiblePositionalControl());

        // Pide 20 estando en 10: distancia de partida 10.
        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(20d),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 10d);   // d=10
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 19d);   // d=1
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 22d);   // d=2, CRECIÓ
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 20d);   // llegó

        // El sobrepaso de 19 a 22 hace crecer la distancia respecto de la anterior,
        // pero nunca supera los 10 de partida: no es divergencia.
        Assert.False(calibration.IsInverted("ifly-737-max8", "gear.autobrake_sw"));
        Assert.Single(calculator.ExecutedCodes);
        Assert.DoesNotContain(
            broadcasts,
            b => b["operation"]?.GetValue<string>() == "confirmAfterWrite");
    }

    /// <summary>
    /// Y el contraste: superar la distancia de PARTIDA sí es divergencia real.
    /// </summary>
    [Fact]
    public void ConfirmAfterWrite_InvertsPolarity_WhenItPassesTheStartingDistance()
    {
        var calculator = new FakeCalculatorCodeClient();
        var calibration = new PolarityCalibration();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator,
            polarityCalibration: calibration);

        SetMatchedProfile(service, MakeProfileWithInvertiblePositionalControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "gear.autobrake_sw", RawValue: JsonValue.Create(20d),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 10d);  // d=10, partida
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 5d);   // d=15 > 10

        Assert.True(calibration.IsInverted("ifly-737-max8", "gear.autobrake_sw"));

        // La reescritura corregida comparte trigger con la original y espera turno
        // (ver el comentario extendido en
        // ConfirmAfterWrite_InvertsPolarityAndRetries_WhenValueMovesAwayFromTarget).
        Thread.Sleep(TriggerSpacingSettleMs);
        InvokePrivate(service, "DrainDeferredTriggerWrites");

        Assert.Equal(2, calculator.ExecutedCodes.Count);
    }

    /// <summary>
    /// Regresión de la avalancha, en su versión "pulsos". Sacar los momentáneos del
    /// filtro AlreadyAtValue arregla el pulso de soltar, pero si se los saca del
    /// todo se escriben SIEMPRE -- y al conectar llegan los 580 en su estado inicial
    /// (sueltos). A ~650 ms cada ExecuteCalculatorCode eso son ~6 minutos de canal
    /// FSUIPC tapado: exactamente el bug que arregló la 0.1.12, por otra puerta.
    ///
    /// La regla es por pares: el "soltar" solo se ejecuta si nosotros pulsamos antes.
    /// </summary>
    [Fact]
    public void MomentaryButton_ReleaseWithoutAPrecedingPress_IsSkipped()
    {
        var calculator = new FakeCalculatorCodeClient();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithMomentaryButton());

        // Estado inicial que emite el otro bridge al conectar: el botón está suelto.
        // No hubo ningún "pulsar" nuestro que cerrar, así que no hay nada que hacer.
        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "navigation.irs_kb_0_sw", RawValue: JsonValue.Create(false),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Empty(calculator.ExecutedCodes);
    }

    /// <summary>
    /// El par completo sí se ejecuta entero: pulsar y soltar, incluso cuando la
    /// lectura dice que el botón ya está suelto (que es lo normal, porque vuelve
    /// solo antes de que llegue el "soltar").
    /// </summary>
    [Fact]
    public void MomentaryButton_FullPressReleasePair_IsAlwaysExecuted()
    {
        var calculator = new FakeCalculatorCodeClient();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithMomentaryButton());

        // El sim reporta el botón suelto (reposo).
        InvokePrivate(service, "OnNumericValueReceived", "navigation.irs_kb_0_sw", 0d);

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "navigation.irs_kb_0_sw", RawValue: JsonValue.Create(true),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "navigation.irs_kb_0_sw", RawValue: JsonValue.Create(false),
            Source: "peer", Sequence: 2, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Equal(2, calculator.ExecutedCodes.Count);
        Assert.Contains("if{ 11 ", calculator.ExecutedCodes[0]);   // pulsar
        Assert.Contains("els{ 12 ", calculator.ExecutedCodes[1]);  // soltar

        // Y un segundo "soltar" suelto ya no dispara nada: el par está cerrado.
        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "navigation.irs_kb_0_sw", RawValue: JsonValue.Create(false),
            Source: "peer", Sequence: 3, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Equal(2, calculator.ExecutedCodes.Count);
    }

    /// <summary>
    /// Un botón momentáneo no puede entrar al lazo de convergencia: vuelve solo, la
    /// lectura nunca sostiene el valor pedido, y cada reintento volvería a PULSAR la
    /// tecla. El perfil generado declara confirmAfterWrite:true para los 568
    /// momentáneos del iFly, así que el bridge tiene que descartarlos él.
    ///
    /// Sin esto, una pulsación del otro piloto escribía el mismo carácter hasta
    /// nueve veces en el CDU.
    /// </summary>
    [Fact]
    public void MomentaryButton_IsNeverRetried_EvenWhenTheReadingNeverMatches()
    {
        var calculator = new FakeCalculatorCodeClient();
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithMomentaryButton());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "navigation.irs_kb_0_sw", RawValue: JsonValue.Create(true),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Single(calculator.ExecutedCodes);

        // El botón vuelve solo: la lectura nunca iguala el valor pedido. Aun así,
        // pasada toda la ventana no debe haber ni un reintento ni un error.
        Thread.Sleep(500);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");

        Assert.Single(calculator.ExecutedCodes);
        Assert.DoesNotContain(
            broadcasts,
            b => b["operation"]?.GetValue<string>() == "confirmAfterWrite");
    }

    /// <summary>
    /// El debouncer existe para colapsar interruptores ruidosos, pero en un
    /// momentáneo el pulsar y el soltar son AMBOS significativos y caen dentro de la
    /// misma ventana. Con el debounceMs:50 que declara el perfil, un doble toque
    /// rápido en el CDU perdía la segunda pulsación.
    ///
    /// Las cuatro transiciones tienen que salir, en orden y sin retraso.
    /// </summary>
    [Fact]
    public void MomentaryButton_EmitsEveryTransition_WithoutDebouncing()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        SetMatchedProfile(service, MakeProfileWithMomentaryButton());

        // Doble toque rápido, todo dentro de la ventana de 50 ms del perfil.
        InvokePrivate(service, "OnNumericValueReceived", "navigation.irs_kb_0_sw", 1d);
        InvokePrivate(service, "OnNumericValueReceived", "navigation.irs_kb_0_sw", 0d);
        InvokePrivate(service, "OnNumericValueReceived", "navigation.irs_kb_0_sw", 1d);
        InvokePrivate(service, "OnNumericValueReceived", "navigation.irs_kb_0_sw", 0d);

        var emitted = broadcasts
            .Where(b => b["type"]?.GetValue<string>() == "control.event")
            .Select(b => b["value"]!.GetValue<bool>())
            .ToArray();

        Assert.Equal(new[] { true, false, true, false }, emitted);
    }

    /// <summary>
    /// Un control NO pulso sigue debounceado: sacar del debouncer a los pulsos no
    /// puede haber desactivado el debouncing en general.
    /// </summary>
    [Fact]
    public void NonPulseControl_IsStillDebounced()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        SetMatchedProfile(service, MakeProfileWithDebouncedPositionalControl(debounceMs: 5000));

        // Dos cambios seguidos dentro de la ventana: el debouncer tiene que emitir
        // solo el primero de inmediato y diferir el segundo.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 1d);
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 2d);

        var emitted = broadcasts
            .Where(b => b["type"]?.GetValue<string>() == "control.event")
            .Select(b => b["value"]!.GetValue<double>())
            .ToArray();

        Assert.Equal(new[] { 1d }, emitted);
    }

    /// <summary>
    /// Selector posicional con una ventana de debounce REAL, para poder comprobar que
    /// el debouncing sigue vivo para todo lo que no es un pulso.
    /// </summary>
    private static AircraftProfile MakeProfileWithDebouncedPositionalControl(int debounceMs)
    {
        var baseProfile = MakeProfileWithInvertiblePositionalControl();
        var control = baseProfile.Controls[0];

        return new AircraftProfile
        {
            ProfileId = baseProfile.ProfileId,
            Manifest = baseProfile.Manifest,
            Detection = baseProfile.Detection,
            Controls = new[]
            {
                new ControlDefinition
                {
                    Id = control.Id,
                    DataType = control.DataType,
                    Authority = control.Authority,
                    ReadOnly = control.ReadOnly,
                    WriteOnly = control.WriteOnly,
                    Read = control.Read,
                    Write = control.Write,
                    Synchronization = new ControlSynchronization
                    {
                        Mode = control.Synchronization.Mode,
                        DebounceMs = debounceMs,
                        ConfirmAfterWrite = false,
                        TimeoutMs = control.Synchronization.TimeoutMs,
                    },
                },
            },
        };
    }

    /// <summary>
    /// EL LAZO DE ECO. Al escribir un pulso por orden del otro piloto, nuestro sim
    /// reporta el cambio -- y si eso se reemite como cambio local, el otro lado lo
    /// reescribe (los pulsos no pasan por AlreadyAtValue) y su botón se pulsa otra
    /// vez, realimentando el ciclo.
    ///
    /// Para los posicionales este eco es inofensivo porque AlreadyAtValue lo descarta
    /// en el otro extremo: ese filtro hacía doble función y los pulsos, al quedar
    /// fuera, necesitan la supresión explícita.
    /// </summary>
    [Fact]
    public void MomentaryButton_ReadbackOfARemoteWrite_IsNotReEmittedAsALocalChange()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        SetMatchedProfile(service, MakeProfileWithMomentaryButton());

        // El otro piloto pulsa: se escribe en nuestro sim.
        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "navigation.irs_kb_0_sw", RawValue: JsonValue.Create(true),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        // Nuestro sim reporta el botón hundido: es el eco de la escritura de arriba.
        InvokePrivate(service, "OnNumericValueReceived", "navigation.irs_kb_0_sw", 1d);

        Assert.DoesNotContain(broadcasts, b => b["type"]?.GetValue<string>() == "control.event");

        // Pero el siguiente cambio ya NO es eco: es el botón volviendo de verdad, y
        // tiene que salir.
        InvokePrivate(service, "OnNumericValueReceived", "navigation.irs_kb_0_sw", 0d);

        var emitted = broadcasts
            .Where(b => b["type"]?.GetValue<string>() == "control.event")
            .Select(b => b["value"]!.GetValue<bool>())
            .ToArray();
        Assert.Equal(new[] { false }, emitted);
    }

    /// <summary>
    /// Una pulsación LOCAL, sin ninguna escritura remota previa, sí se emite: la
    /// supresión de eco no puede silenciar lo que el piloto de este lado hace.
    /// </summary>
    [Fact]
    public void MomentaryButton_LocalPress_IsAlwaysEmitted()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        SetMatchedProfile(service, MakeProfileWithMomentaryButton());

        InvokePrivate(service, "OnNumericValueReceived", "navigation.irs_kb_0_sw", 1d);

        Assert.Contains(
            broadcasts,
            b => b["type"]?.GetValue<string>() == "control.event"
                && b["value"]!.GetValue<bool>());
    }

    [Fact]
    public void WriteOnlyTriggerMirror_LocalCockpitPulse_IsEmittedAsControlEvent()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        var profile = MakeProfileWithWriteOnlySinglePressButton();
        SetMatchedProfile(service, profile);
        InvokePrivate(service, "IndexWriteOnlyTriggerMirrors", profile);

        InvokePrivate(service, "OnNumericValueReceived", "__trigger__:L:VC_Communications_trigger_VAL", 83d);

        Assert.Contains(
            broadcasts,
            b => b["type"]?.GetValue<string>() == "control.event"
                && b["controlId"]?.GetValue<string>() == "communications.acp_1_transmitter_01_sw"
                && b["value"]!.GetValue<bool>());
    }

    [Fact]
    public void WriteOnlyTriggerMirror_ReadbackOfRemoteWrite_IsSuppressed()
    {
        var broadcasts = new List<JsonObject>();
        var calculator = new FakeCalculatorCodeClient();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        var profile = MakeProfileWithWriteOnlySinglePressButton();
        SetMatchedProfile(service, profile);
        InvokePrivate(service, "IndexWriteOnlyTriggerMirrors", profile);

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: "communications.acp_1_transmitter_01_sw", RawValue: JsonValue.Create(true),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        InvokePrivate(service, "OnNumericValueReceived", "__trigger__:L:VC_Communications_trigger_VAL", 83d);

        Assert.Single(calculator.ExecutedCodes);
        Assert.DoesNotContain(
            broadcasts,
            b => b["type"]?.GetValue<string>() == "control.event"
                && b["controlId"]?.GetValue<string>() == "communications.acp_1_transmitter_01_sw");
    }

    [Fact]
    public void WriteOnlyTriggerMirror_DifferentCodesOnSameTrigger_AreDistinguished()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        var profile = MakeProfileWithTwoWriteOnlyButtonsOnSharedTrigger();
        SetMatchedProfile(service, profile);
        InvokePrivate(service, "IndexWriteOnlyTriggerMirrors", profile);

        InvokePrivate(service, "OnNumericValueReceived", "__trigger__:L:VC_Communications_trigger_VAL", 83d);
        InvokePrivate(service, "OnNumericValueReceived", "__trigger__:L:VC_Communications_trigger_VAL", 84d);

        var emittedIds = broadcasts
            .Where(b => b["type"]?.GetValue<string>() == "control.event")
            .Select(b => b["controlId"]!.GetValue<string>())
            .ToArray();

        Assert.Equal(
            new[] { "communications.acp_1_transmitter_01_sw", "communications.acp_2_transmitter_01_sw" },
            emittedIds);
    }

    [Fact]
    public void WriteOnlyTriggerMirror_AmbiguousSameCode_IsEmittedUsingCanonicalControl()
    {
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: new FakeCalculatorCodeClient());

        var profile = MakeProfileWithAmbiguousWriteOnlyButtons();
        SetMatchedProfile(service, profile);
        InvokePrivate(service, "IndexWriteOnlyTriggerMirrors", profile);

        InvokePrivate(service, "OnNumericValueReceived", "__trigger__:L:VC_Navigation_trigger_VAL", 453d);

        Assert.Contains(
            broadcasts,
            b => b["type"]?.GetValue<string>() == "control.event"
                && b["controlId"]?.GetValue<string>() == "navigation.cdu1_handle_click_01");
        Assert.Contains(
            broadcasts,
            b => b["type"]?.GetValue<string>() == "bridge.error"
                && b["message"]?.GetValue<string>()?.Contains("trigger ambiguo", StringComparison.OrdinalIgnoreCase) == true);
    }

    /// <summary>
    /// Botón momentáneo del teclado del CDU, copiado literal de
    /// aircraft-profiles/ifly-737-max8/controls/navigation.yaml (incluido el
    /// confirmAfterWrite:true que trae el perfil generado, que es justo lo que el
    /// bridge tiene que ignorar para esta clase de control).
    /// </summary>
    private static AircraftProfile MakeProfileWithMomentaryButton()
    {
        var control = new ControlDefinition
        {
            Id = "navigation.irs_kb_0_sw",
            DataType = ControlDataType.Boolean,
            Authority = ControlAuthority.Shared,
            ReadOnly = false,
            WriteOnly = false,
            Read = new ControlReadDefinition
            {
                Type = ReadType.ClientDataArea,
                AreaName = "SharedCockpitBridge_LVars",
                Field = "L:VC_IRS_KB_0_SW_VAL",
                NativeType = ClientDataNativeType.Float,
            },
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = "$value 0 > if{ 11 (>L:VC_Navigation_trigger_VAL,number) } " +
                       "els{ 12 (>L:VC_Navigation_trigger_VAL,number) }",
            },
            Synchronization = new ControlSynchronization
            {
                Mode = SyncMode.Event,
                DebounceMs = 0,
                ConfirmAfterWrite = true,
                TimeoutMs = 400,
            },
        };

        return new AircraftProfile
        {
            ProfileId = "ifly-737-max8",
            Manifest = new AircraftManifest(),
            Detection = new DetectionRule(),
            Controls = new[] { control },
        };
    }

    private static AircraftProfile MakeProfileWithWriteOnlySinglePressButton()
    {
        var control = new ControlDefinition
        {
            Id = "communications.acp_1_transmitter_01_sw",
            DataType = ControlDataType.Boolean,
            Authority = ControlAuthority.Shared,
            ReadOnly = false,
            WriteOnly = true,
            Read = null,
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = "$value 0 > if{ 83 (>L:VC_Communications_trigger_VAL,number) }",
            },
            Synchronization = new ControlSynchronization
            {
                Mode = SyncMode.Event,
                DebounceMs = 100,
                ConfirmAfterWrite = false,
                TimeoutMs = 400,
            },
        };

        return new AircraftProfile
        {
            ProfileId = "ifly-737-max8",
            Manifest = new AircraftManifest(),
            Detection = new DetectionRule(),
            Controls = new[] { control },
        };
    }

    private static AircraftProfile MakeProfileWithTwoWriteOnlyButtonsOnSharedTrigger()
    {
        var first = MakeProfileWithWriteOnlySinglePressButton().Controls[0];
        var second = new ControlDefinition
        {
            Id = "communications.acp_2_transmitter_01_sw",
            DataType = ControlDataType.Boolean,
            Authority = ControlAuthority.Shared,
            ReadOnly = false,
            WriteOnly = true,
            Read = null,
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = "$value 0 > if{ 84 (>L:VC_Communications_trigger_VAL,number) }",
            },
            Synchronization = new ControlSynchronization
            {
                Mode = SyncMode.Event,
                DebounceMs = 100,
                ConfirmAfterWrite = false,
                TimeoutMs = 400,
            },
        };

        return new AircraftProfile
        {
            ProfileId = "ifly-737-max8",
            Manifest = new AircraftManifest(),
            Detection = new DetectionRule(),
            Controls = new[] { first, second },
        };
    }

    private static AircraftProfile MakeProfileWithAmbiguousWriteOnlyButtons()
    {
        var first = new ControlDefinition
        {
            Id = "navigation.cdu1_handle_click_01",
            DataType = ControlDataType.Boolean,
            Authority = ControlAuthority.Shared,
            ReadOnly = false,
            WriteOnly = true,
            Read = null,
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = "$value 0 > if{ 453 (>L:VC_Navigation_trigger_VAL,number) }",
            },
            Synchronization = new ControlSynchronization
            {
                Mode = SyncMode.Event,
                DebounceMs = 100,
                ConfirmAfterWrite = false,
                TimeoutMs = 400,
            },
        };

        var second = new ControlDefinition
        {
            Id = "navigation.cdu1_handle_click_02",
            DataType = ControlDataType.Boolean,
            Authority = ControlAuthority.Shared,
            ReadOnly = false,
            WriteOnly = true,
            Read = null,
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = "$value 0 > if{ 453 (>L:VC_Navigation_trigger_VAL,number) }",
            },
            Synchronization = new ControlSynchronization
            {
                Mode = SyncMode.Event,
                DebounceMs = 100,
                ConfirmAfterWrite = false,
                TimeoutMs = 400,
            },
        };

        return new AircraftProfile
        {
            ProfileId = "ifly-737-max8",
            Manifest = new AircraftManifest(),
            Detection = new DetectionRule(),
            Controls = new[] { first, second },
        };
    }

    /// <summary>
    /// Igual que MakeProfileWithConfirmAfterWriteControl pero con el RPN de DOS
    /// ramas que emite de verdad tools/generate_ifly_profile.py para un selector
    /// posicional -- la única forma que el bridge puede invertir solo.
    /// </summary>
    private static AircraftProfile MakeProfileWithInvertiblePositionalControl()
    {
        var control = new ControlDefinition
        {
            Id = "gear.autobrake_sw",
            DataType = ControlDataType.Number,
            Authority = ControlAuthority.Shared,
            ReadOnly = false,
            WriteOnly = false,
            Read = new ControlReadDefinition
            {
                Type = ReadType.ClientDataArea,
                AreaName = "SharedCockpitBridge_LVars",
                Field = "L:VC_Autobrake_SW_VAL",
                NativeType = ClientDataNativeType.Float,
            },
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = "(L:VC_Autobrake_SW_VAL,number) $value < if{ 2 (>L:VC_Gear_trigger_VAL,number) } " +
                       "(L:VC_Autobrake_SW_VAL,number) $value > if{ 3 (>L:VC_Gear_trigger_VAL,number) }",
            },
            Synchronization = new ControlSynchronization
            {
                Mode = SyncMode.Event,
                DebounceMs = 0,
                ConfirmAfterWrite = true,
                TimeoutMs = 400,
            },
        };

        return new AircraftProfile
        {
            ProfileId = "ifly-737-max8",
            Manifest = new AircraftManifest(),
            Detection = new DetectionRule(),
            Controls = new[] { control },
        };
    }

    private static AircraftProfile MakeProfileWithConfirmAfterWriteControl()
    {
        var control = new ControlDefinition
        {
            Id = "gear.autobrake_sw",
            DataType = ControlDataType.Number,
            Authority = ControlAuthority.Shared,
            ReadOnly = false,
            WriteOnly = false,
            Read = new ControlReadDefinition
            {
                Type = ReadType.ClientDataArea,
                AreaName = "SharedCockpitBridge_LVars",
                Field = "L:VC_Autobrake_SW_VAL",
                NativeType = ClientDataNativeType.Float,
            },
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = "(L:VC_Autobrake_SW_VAL,number) $value < if{ 2 (>L:VC_Gear_trigger_VAL,number) }",
            },
            Synchronization = new ControlSynchronization
            {
                Mode = SyncMode.Event,
                DebounceMs = 0,
                ConfirmAfterWrite = true,
                TimeoutMs = 400,
            },
        };

        return new AircraftProfile
        {
            ProfileId = "ifly-737-max8",
            Manifest = new AircraftManifest(),
            Detection = new DetectionRule(),
            Controls = new[] { control },
        };
    }

    private static void SetMatchedProfile(BridgeService service, AircraftProfile profile)
    {
        var field = typeof(BridgeService).GetField("_matchedProfile", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(field);
        field!.SetValue(service, profile);
    }

    private static void InvokePrivate(BridgeService service, string methodName, params object[] args)
    {
        var argTypes = args.Select(a => a.GetType()).ToArray();
        var method = typeof(BridgeService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Instance, null, argTypes, null);
        Assert.NotNull(method);
        method!.Invoke(service, args);
    }

    private sealed class FakeCalculatorCodeClient : ICalculatorCodeClient
    {
        public bool IsConnected => true;
        public List<string> ExecutedCodes { get; } = new();

        public bool TryConnect(string appName) => true;

        public bool ExecuteCalculatorCode(string code)
        {
            ExecutedCodes.Add(code);
            return true;
        }
    }

    private sealed class FakeSimConnectClient : ISimConnectClient
    {
        public bool IsConnected => true;
        public event Action? Connected;
        public event Action? Disconnected;
        public event Action<string>? SimConnectException;
        public event Action<string, double>? NumericValueReceived;
        public event Action<string, string>? StringValueReceived;

        public bool TryConnect(string appName) => true;
        public void Disconnect() { }
        public void Pump() { }
        public void SubscribeNumeric(string key, string simVarName, string units, PollMode mode) { }
        public void SubscribeString(string key, string simVarName, PollMode mode) { }
        public void TransmitSetEvent(string eventName, uint dwData) { }
        public void WriteNumeric(string key, double value) { }
        public void Dispose() { }
    }

    private sealed class FakeLog : ILog
    {
        public void Info(string message) { }
        public void Warn(string message) { }
        public void Error(string message) { }
        public void Debug(string message) { }
    }
}
